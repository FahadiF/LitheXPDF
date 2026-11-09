# ADR 0004: Version the custom print selection payload

- Status: Accepted
- Date: 2026-11-09

## Context

The LitheXPDF print dialog needs to send a current-page, all-pages, or inclusive
page-range selection to the worker. The previous `PRINT` payload was 36 bytes
and carried only the current page and owner-window handle. Adding selection
fields changes that wire contract. Reusing the larger payload while retaining
protocol version 1 would make the same version number mean two different
payload layouts.

## Decision

Bump the shared `PDFW` protocol version to 2 for the host, worker, and frontend
render-result validator. `PRINT` now has an exact 45-byte payload: document
identity, current page, owner window handle, selection mode, and one-based range
start/end. The host and worker validate the mode, range, active generation, and
10,000-page job limit. The worker still renders and submits one bounded page
bitmap at a time. The Windows dialog remains responsible for printer choice
and driver-specific settings; its separate page controls are disabled.

## Consequences

All packaged parts must come from the same build. A version 1 host or worker is
rejected by the version 2 frame validator instead of interpreting the changed
payload. `PRINT_RESULT` and page-result field layouts are unchanged, but their
frame headers use version 2. Existing protocol fixtures must use version 2.
