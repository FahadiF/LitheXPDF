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
- The frontend retains one visible decoded image and at most two encoded page
  responses for the active document, with a 16 MiB total encoded-response cap.
  The cache contains only validated binary render envelopes; it creates no
  image elements or object URLs. Opening/replacing/closing a document clears
  all encoded entries, clears image sources/references, and revokes its object
  URL. No inactive document has encoded or decoded page images.
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
| Frontend encoded page-response cache | 16 MiB and at most 2 pages | Cache only validated next-page responses; do not cache an individual response above 16 MiB; evict oldest entries to satisfy both caps; clear on document change/close |
| Decoded WebView images | 1 page, at most 32 MiB RGBA dimensions | Clear `src`, remove element/references, revoke URL on replacement/deactivation |
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


## Current single-document UI accounting

The current single-document view creates one lightweight DOM slot per page in the active document and reuses one decoded <img> element for the page nearest the viewport. It does not eagerly render all pages. After one second without page changes it may prefetch the immediately following page into a cache of at most two encoded responses and 16 MiB total. It does not retain decoded images or object URLs for prefetched pages. On a page change, the prior image remains assigned until the replacement response is validated; the prior src is then cleared and its URL revoked. Opening/replacing/closing a document clears all prefetched bytes and revokes the active image URL. The page-slot DOM grows with page count and is not yet virtualized. The raw IPC response and the frontend's copied PNG bytes/Blob can overlap temporarily during image handoff; this transient peak has not been measured. These implementation details are not evidence of a memory improvement or a total-process memory bound.

The five-slot DOM experiment was reverted after it truncated navigation and
did not provide a bounded object-URL lifecycle. The current one-image design
remains the active implementation. Any future virtualization work must retain
the full scroll extent and prove bounded image cleanup with tests; it must not
be described as a memory improvement until measured.

Text search runs serially in the PDFium worker and returns at most 250 result
rows. The query is capped at 512 UTF-8 bytes and each excerpt at 128 UTF-8
bytes; a larger result set is truncated. This bounds the protocol response and
frontend result list, but does not hard-bound PDFium's internal text extraction
or allocations for a page. Search timeout terminates and reaps the worker if
the operation exceeds its deadline. Bookmarks and theme preference are small
localStorage metadata; they never retain rendered images or PDF contents.


## Bounded next-page prefetch — 2026-11-08

After a page response is installed, the frontend waits 1,000 ms without a
page change before requesting the immediately following page. It never scans
ahead beyond one page. A prefetched frame is validated before being cached.
The cache is limited to two encoded responses and 16 MiB total; any response
larger than 16 MiB is displayed when requested but is not cached. A queued
prefetch is cancelled when the user navigates elsewhere or closes/replaces
the document. If the user selects the page currently being prefetched, that
request is promoted and reused. At most one decoded <img> and its object URL
are retained, and the centered loading indicator is reserved for the initial
open; page transitions keep it hidden and replace the image only after the
new validated response arrives.

The prefetch delay and cache limits are initial test targets, not measured
performance or memory improvements. Full-document eager rendering is not used.
