# PDFium worker

The worker owns the only PDFium dependency. Its current executable exposes a
diagnostic path for a real load/open/render/close proof; it is not yet the
production framed IPC loop and is not yet launched by the Tauri host.

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
