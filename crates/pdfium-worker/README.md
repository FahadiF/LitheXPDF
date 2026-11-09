# PDFium worker

The worker owns the only PDFium dependency and runs either the diagnostic
smoke path or the version-2 `PDFW` framed stdio server. In server mode the
main OS thread binds PDFium, emits `READY`, and serially handles OPEN, RENDER,
CLOSE, and SHUTDOWN requests. The Tauri host launches this executable as its
sidecar and reads raw stdout bytes.

The worker manifest pins `pdfium-render =0.9.4` with default features disabled
and explicitly enables `pdfium_7881`, `image_025`, and `thread_safe`. A direct
`image =0.25.10` dependency enables only PNG encoding. All native PDFium work
runs synchronously on the worker process's main OS thread.

Run the smoke path with absolute paths:

```powershell
target\debug\pdfium-worker.exe --smoke-test `
  --pdfium-path "$PWD\src-tauri\resources\pdfium\pdfium.dll" `
  --input "$PWD\crates\pdfium-worker\tests\fixtures\smoke-one-page.pdf" `
  --output "$env:TEMP\lithexpdf-smoke.png"
```

The smoke path does not search the working directory or system DLL locations.
It bounds output dimensions, pixels, RGBA bytes, and encoded PNG bytes. The
selected runtime's exact hashes, notice inventory, native imports, tests, and
remaining packaging limits are recorded in `docs/TESTING.md`.

The supervised server mode accepts `--serve --pdfium-path <absolute-path>`
and reads binary frames from stdin, writing binary frames to stdout. Protocol
version 2 includes bounded text search and page-range printing. Diagnostics go
to stderr. Do not write log text to stdout in server mode.
