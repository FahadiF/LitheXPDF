# ADR 0005: PDF annotation editing

## Status

Accepted for implementation. A bounded one-page API probe passes against the
currently selected Windows x64 PDFium DLL; the user-facing feature and
host-worker protocol remain unimplemented.

## Decision

The 1.0 annotation tools cover standard highlights, text notes, and freehand
ink. The frontend converts interactions to page-space geometry; the worker
creates and saves PDF annotations. Zoom and page rotation are view transforms
and must not mutate stored geometry.

Saving creates a new annotated PDF copy. The original file is not overwritten
by default. The worker writes to a temporary sibling file, flushes and closes
it, then finalizes the requested output path. On failure it removes the
temporary file and preserves the source.

## Constraints and validation

- The Tauri host never links PDFium. All annotation handles and PDFium calls
  stay on the worker's single owner thread.
- Annotation messages use the existing bounded binary host-worker protocol;
  the protocol version changes together with host and worker.
- Validate finite coordinates, page bounds, text length, color/width bounds,
  point counts, request lengths, and output paths before native calls or file
  writes.
- `pdfium-render` 0.9.4 exposes low-level bindings for experimental PDFium
  annotation APIs. The current DLL successfully created and reloaded one
  highlight, free-text, and ink annotation in the deterministic one-page
  fixture. This is only an API probe; it does not verify multi-page geometry,
  rotation, broad PDF compatibility, host-worker protocol, or UI behavior.
- Verify generated output by reopening it and checking that all annotation
  subtypes persist. Confirm the original file hash is unchanged.

## Consequences

This adds a protocol operation and a file-save path, and requires interaction
design for text selection and freehand input. It preserves the worker boundary
and avoids destructive in-place editing. PDFium compatibility for annotation
creation and serialization remains an explicit release gate.
