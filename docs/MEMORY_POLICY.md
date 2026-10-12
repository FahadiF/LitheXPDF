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
- The frontend retains the visible image and a bounded encoded-image LRU for
  the active tab only. Deactivation clears all encoded entries for that tab,
  clears image element sources/references, and revokes its object URLs before
  activating another tab. No inactive tab has encoded or decoded page images.
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
| Frontend encoded image cache | 64 MiB | Active-tab-only LRU; clear completely on deactivation |
| Decoded WebView images | 1 page, at most 32 MiB RGBA dimensions | Clear `src`, remove element/references, revoke URL on replacement/deactivation |
| IPC control/request payload | 64 KiB per frame | Reject before allocation |
| IPC image-result payload | 32 MiB image bytes + at most 4 KiB metadata | Reject malformed/oversized frame and restart worker |
| Temporary encoding output buffer | 32 MiB | Bounded writer aborts at cap; discard partial output |
| Encoder scratch allocations | 8 MiB initial measurement target | Measure in worker; compatibility milestone must validate encoder behavior |
| Concurrent result payloads awaiting UI | 1 | Backpressure worker/host until consumed or invalidated |
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

