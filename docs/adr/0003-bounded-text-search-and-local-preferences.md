# ADR 0003: Bounded text search and local reader preferences

- Status: Accepted
- Date: 2026-11-08

## Context

The reader needs page-number navigation, bookmarks, text search, and a light
theme without moving PDFium into the frontend, adding another renderer, or
keeping another native document open.

## Decision

- Keep text extraction and search inside the existing PDFium worker, on its
  single owner thread and against the one active document.
- Add `SEARCH` and `SEARCH_RESULTS` to the versioned worker protocol. Bound a
  query to 512 UTF-8 bytes, a response to 250 results, and each excerpt to 128
  UTF-8 bytes. Use a 30-second search deadline. A hung native search is handled
  by terminating and reaping the worker; it is not cancelled in place.
- Include document identity and generation in each search request and result.
  The host and frontend discard replies that no longer belong to the active
  document or query.
- Search only text present in the PDF. OCR is not part of this milestone.
- Persist bookmarks as page numbers and labels in WebView local storage, under
  a key derived from the normalized document path. The path hash is not
  encryption. Persist the theme choice locally as UI preference. Do not store
  document bytes, text contents, or rendered images in these records.
- Place a one-based page-number field between Previous and Next. Validate the
  entered number against the active page count before navigation.

## Consequences

Search works for documents with a text layer and is bounded at the IPC and UI
result-list layers. PDFium's internal text extraction allocations are not
proven to have a hard memory cap. Bookmarks are local to the WebView profile;
they are not synchronized or encrypted. No memory or performance improvement
is claimed without measurements. Automated tests cover search framing and
fixture results, stale-result rejection, page jumps, bookmarks, and theme
preference; manual WebView2 review remains required.
