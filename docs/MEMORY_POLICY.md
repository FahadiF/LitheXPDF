# Memory policy

This document defines starting limits to implement and measure. These are
budgets to test, not evidence that memory use has already improved.

## Ownership and retention

- A background tab retains only its ID, path, page index, zoom, scroll
  position, and generation. It retains no document handle, encoded image,
  decoded WebView image, or page bitmap.
- One child process owns the one active PDFium document and all PDFium objects.
- At most one render executes at a time. A render bitmap is dropped after
  encoding and response transmission.
- The frontend retains page image elements and Blob object URLs for the active
  document only. It keeps at most 30 pages, with separate 64 MiB caps for
  encoded PNG bytes and estimated decoded RGBA bytes. The image cache stores
  no response ArrayBuffers. Opening/replacing/closing a document clears image
  sources and element references and revokes every object URL. No inactive
  document has encoded or decoded page images.
- Document close is required for releasing document-owned native objects.
  It is not evidence that the Windows working set immediately falls; report
  process private bytes and working set separately.
- A forced worker exit releases that worker's process address space and OS
  handles, which is a recovery mechanism and may have a visible restart cost.

## Initial explicit limits

These defaults are conservative hypotheses for the first implementation and
must be tuned using the benchmark corpus:

| Resource | Initial cap | Overflow behavior |
| --- | ---: | --- |
| Open PDFium worker processes | 1 | Never start a second worker while the first is alive |
| Open PDFium documents | 1 | Close active document before opening the next |
| Active render | 1 | Serialize in worker |
| Pending render requests | 2 | Coalesce same-tab viewport updates; reject superseded work |
| Maximum bitmap pixels | 8,388,608 | Reject request or downscale while preserving aspect ratio |
| Maximum width or height | 8,192 px | Reject request or downscale while preserving aspect ratio |
| Maximum RGBA bitmap bytes | 32 MiB | Enforce before allocating/rendering where possible |
| Maximum encoded image payload | 32 MiB | Abort bounded writer; return `IMAGE_TOO_LARGE`, never send partial bytes |
| Active-document encoded PNG image cache | 64 MiB and at most 30 page images; mode windows are 0, 3, 12 (default), or up to 30 pages ahead, with a 30-image total cap | Cache only validated responses as Blob URLs; never cache an individual image above the 32 MiB protocol cap; evict the farthest inactive page when either byte cap or page count is exceeded; clear on document change/close and when preloading is disabled |
| Decoded WebView images | 64 MiB estimated RGBA bytes and at most 30 page images | Estimate each image as width × height × 4; evict farthest inactive images when limits are reached; clear `src`, remove element/references, and revoke URL on eviction/deactivation |
| IPC control/request payload | 64 KiB per frame | Reject before allocation |
| IPC image-result payload | 32 MiB image bytes + at most 4 KiB metadata | Reject malformed/oversized frame and restart worker |
| Search query payload | 512 UTF-8 bytes plus fixed request metadata | Reject before dispatch |
| Search result metadata | 250 matches × at most 128 UTF-8 bytes per excerpt; response stays under 64 KiB | Truncate at 250 results and mark truncated |
| Temporary encoding output buffer | 32 MiB | Bounded writer aborts at cap; discard partial output |
| Encoder scratch allocations | 8 MiB initial measurement target | Measure in worker; compatibility milestone must validate encoder behavior |
| Concurrent result payloads awaiting UI | 1 | Backpressure worker/host until consumed or invalidated |
| Render response timeout | 30,000 ms initial configurable test default; accepted range 1,000–120,000 ms | Invalidate request/generation, terminate and reap worker asynchronously, return timeout; old worker exits before restart |
| Worker shutdown grace period | 2 seconds | Terminate child and reclaim its address space |

The 32 MiB bitmap cap follows 8,388,608 pixels × 4 bytes/pixel. These are
separate accounting categories: renderer-owned RGBA bitmap memory; bounded
encoded PNG output/cache; decoded WebView image storage; worker/host frame and
payload buffers; and temporary encoder scratch. The encoded output hard cap
does not bound encoder scratch or PDFium's internal allocations. The 8 MiB
scratch value is a measured target, not a guaranteed bound until the selected
encoder is verified. If it cannot be bounded or measured acceptably, do not
claim the memory budget is met; stop the compatibility spike and select a
bounded encoder strategy before rendering feature work.

Tauri raw IPC avoids JSON/base64 expansion but may still copy buffers between
the worker, host, IPC layer, and WebView. Budget one result in flight and
measure those copies. The WebView may retain decoder/GPU surfaces after JS
references are dropped; ensure no inactive tab owns references, and measure
WebView memory separately rather than claiming immediate reclamation.
Dimension, pixel, encoded-byte, and frame-length checks all occur before
allocating the corresponding buffer where possible.

The render timeout bounds wait/recovery policy, not memory by itself. It begins
at worker dispatch and is measured separately from queue delay, PDF open,
native rendering, encoding, and IPC delivery. Tune it from repeated latency
measurements on the fixed corpus and supported hardware; retain the 30-second
value only if the measured tail plus margin fits the product wait target and
false worker-restart rates remain acceptable. It is not the shutdown grace:
the 2-second grace starts only after app shutdown sends its framed shutdown
request. Timeout expiry and child termination/reaping are supervised away from
the GUI thread.

## Evidence required before performance claims

Use a reproducible corpus of small, large, image-heavy, and malformed PDFs.
Record OS build, app build, PDFium revision, corpus hashes, machine RAM, and
measurement tool. Sample parent and worker private bytes and working set;
record render/close durations and rejected/coalesced request counts. Compare
the same traces at 1, 10, 30, and 50 tabs; capture the active tab and document
size. Verify that background tabs do not leave encoded/decoded page images and
that the worker has closed its document after a switch. Do not describe a lower working
set, lower memory footprint, or a leak fix as achieved until those
measurements exist and are reported with their limits.


## Current tabbed UI accounting

The tabbed view creates one lightweight DOM slot per page in the active document to preserve the full scroll extent. The frontend keeps at most 100 tab records; each inactive record retains only a tab ID, path, page index, zoom, and scroll offsets. No inactive tab retains document/page objects, encoded images, decoded images, or object URLs. Recommended mode pre-renders up to 12 pages ahead after a 250 ms warm-up; Light uses 3, Maximum targets up to 30, and On demand disables preloading. Image quality is independently configurable: Quality is the default and requests up to 2× display-density dimensions; Speed requests standard display-density dimensions. Both are clamped by the worker's existing 8,192-pixel dimension, 8,388,608-pixel, 32 MiB RGBA, and encoded-image limits. Higher-density pages can reach the existing 64 MiB encoded and 64 MiB estimated-decoded cache ceilings with fewer retained pages; those limits shorten the rolling window. Successful renders are installed as page `<img>` elements in their real slots. The rolling cache keeps up to two previous pages and is limited to 30 images. After each successful prefetch it waits 16 ms before scheduling another serial render. Switching documents clears active image state; tabs remain metadata-only. The page-slot DOM grows with page count and is not yet virtualized. The raw IPC response, copied PNG bytes, Blob storage, decoded WebView image, and PDFium/encoder buffers can overlap temporarily; this transient peak has not been measured. These accounting limits do not bound total process/GPU memory and are not evidence of a memory improvement.

The five-slot DOM experiment was reverted after it truncated navigation and
did not provide a bounded object-URL lifecycle. The current implementation
keeps full-document scroll geometry and a rolling page-image cache. Any future
virtualization work must retain the full scroll extent and prove bounded image
cleanup with tests; it must not be described as a memory improvement until
measured.

Text search runs serially in the PDFium worker and returns at most 250 result
rows. The query is capped at 512 UTF-8 bytes and each excerpt at 128 UTF-8
bytes; a larger result set is truncated. This bounds the protocol response and
frontend result list, but does not hard-bound PDFium's internal text extraction
or allocations for a page. Search timeout terminates and reaps the worker if
the operation exceeds its deadline. Bookmarks and theme preference are small
localStorage metadata; they never retain rendered images or PDF contents.


## Bounded next-page prefetch — 2026-11-08

After the initial page is installed, the frontend waits 250 ms before
preloading starts. The choices are On demand (0 future pages), Light (3),
Recommended (12, default), and Maximum (up to 30). Successful prefetches are
serial, with a 16 ms scheduling gap. The cache retains at most 30 image
elements and enforces independent 64 MiB encoded-PNG and estimated decoded-RGBA
budgets; each response is still capped at 32 MiB by the protocol. It retains
up to two pages behind the current page, then evicts the farthest inactive page
when a cap is reached. A queued prefetch is cancelled on navigation or
document close; a matching in-flight render can be promoted to the visible
page. No preloaded images are retained for inactive tabs. Choosing On demand
clears every non-current image. The centered loader remains reserved for
initial open; page transitions keep it hidden and preserve the old image until
the next validated image is available.

These time and byte limits are implementation settings, not measured speed or
memory improvements. The view provides a full-document scrolling surface, but
does not eagerly render every page or promise zero wait outside the warmed
window. Full-document eager image retention is not used.


The recent-files menu stores at most ten full local paths in WebView local storage because this is required to reopen recent documents. This is local profile data, not encrypted. It does not store PDF contents or page images.
