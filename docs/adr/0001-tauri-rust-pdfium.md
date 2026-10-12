# ADR 0001: Tauri, Rust, and PDFium

- Status: Accepted for the initial implementation; PDFium artifact pairing
  remains a Milestone 0 verification gate.
- Date: 2026-10-12

## Context

The reader is Windows-first, must handle 30+ background tabs with low memory
consumption, and uses Rust stable, Tauri 2, vanilla TypeScript/HTML/CSS,
Cargo, and PDFium through `pdfium-render`. The UI must remain responsive while
large documents load and render. Native cleanup and crash recovery need an
explicit boundary.

## Investigation

- `pdfium-render` documentation says PDFium provides no thread-safety
  guarantees and should be assumed not thread-safe. It provides a
  `thread_safe` feature that serializes calls behind a mutex; keep it enabled
  initially, but still route calls through one owner thread.
- Current crate documentation is for `pdfium-render` 0.9.4. Its default
  `pdfium_latest` API feature is currently `pdfium_7881`; the runtime DLL must
  match the API the crate binds to. This API default may lag current upstream
  binary releases. Milestone 0 must test a matching archived binary and decide
  whether to pin that pair or select a different supported release. Never
  follow a floating `latest` DLL in a reproducible build.
- `pdfium-render` does not include PDFium. It supports dynamic runtime
  binding, which is the selected distribution direction for Windows. The
  `bblanchon/pdfium-binaries` project publishes Windows x64, x86, and arm64
  dynamic-library archives; builds are third-party binaries, not an official
  Google distribution. Pin a release, verify hashes, and package the DLL as a
  Tauri resource beside its applicable license/notices.
- PDFium's upstream `LICENSE` contains BSD-style redistribution terms and
  Apache 2.0 text; PDFium also incorporates third-party components with their
  own notices/licenses. The binary distributor's repository has its own
  license, which is not a substitute for auditing the bundled PDFium artifact
  and its notices. Before release, generate and review a complete dependency
  and native-binary attribution inventory for the exact pinned build.
- Tauri 2's official Windows prerequisites call for Microsoft C++ Build Tools
  and WebView2. Its Windows installer can use the system WebView2 runtime,
  download/embed a bootstrapper, embed the offline installer, or bundle a
  fixed runtime. Fixed/offline runtime modes add substantial installer size;
  prefer the system runtime and normal installer bootstrapper unless offline
  deployment is a product requirement. MSI build may need the optional
  VBScript feature.
- Tauri 2 supports a raw `tauri::ipc::Response` return that the frontend
  `invoke()` receives as an `ArrayBuffer`; large image replies therefore do
  not need JSON arrays, base64, or events. The worker sidecar documentation
  requires an `externalBin` entry and an executable filename suffixed with
  the Rust target triple. The Rust shell plugin can spawn the sidecar; its
  stdout must be configured for raw byte chunks for a framed binary stream.
- `pdfium-render` exposes `Pdfium::bind_to_library(path)`. Use that with an
  absolute path resolved from Tauri's resource directory, never the crate's
  working-directory-sensitive `Pdfium::default()` path search.
- The binary distributor says Windows must be able to find `pdfium.dll`; a
  clean install must also resolve every transitive native dependency. Inspect
  the selected DLL/worker dependency set (including MSVC runtime requirements)
  and verify the chosen installer/runtime strategy on a clean VM. Do not infer
  runtime availability from the development machine.

## Decision

Use the chosen stack unchanged. Put the worker in a separate
`crates/pdfium-worker` Rust binary crate in the Cargo workspace. Keep PDFium
calls in that child process, launched and supervised by the Rust/Tauri host
through Tauri's shell sidecar support. For Windows x64, build target
`x86_64-pc-windows-msvc`, stage as
`src-tauri/binaries/pdfium-worker-x86_64-pc-windows-msvc.exe`, and configure
`bundle.externalBin` with `binaries/pdfium-worker`. The host launches the
basename through `ShellExt::sidecar`, resolves the bundled DLL and notices
through Tauri's resource resolver, and passes the absolute DLL path to the
worker. The worker binds with `Pdfium::bind_to_library(path)`.

The repository-root `Cargo.toml` is the single workspace manifest with
`resolver = "2"` and members `src-tauri` and `crates/pdfium-worker`; the host's
Tauri marker/config remains `src-tauri/tauri.conf.json`. Build the sidecar
from the root with
`cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker`, then
stage its `.exe` at the target-triple-suffixed path above. The canonical DLL
resource mapping is
`src-tauri/resources/pdfium/pdfium.dll` → `pdfium/pdfium.dll`, with notices at
`src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt` →
`pdfium/THIRD_PARTY_NOTICES.txt`. Resolve the DLL through
`BaseDirectory::Resource`; never use the process working directory.

Within the worker, one OS thread owns the PDFium library and at most one
document; serialize all operations. Host/worker messages use bounded,
versioned binary frames over raw sidecar stdin/stdout: 20-byte `PDFW` header,
version 1, big-endian fields, 64 KiB control/request payload cap, and a 32 MiB
encoded-image cap plus at most 4 KiB metadata. WebView render calls return the
framed image as `tauri::ipc::Response::new(Vec<u8>)` and
`@tauri-apps/api/core` `invoke()` receives an `ArrayBuffer`; small metadata may
use JSON events. Never transport large image payloads as JSON. Package a
pinned Windows PDFium DLL with its notices only
after a compatibility spike verifies the exact crate/API/binary tuple, hashes,
dynamic loading, and clean-machine packaged launch. Keep the exact PDFium
tuple open until that gate succeeds.

Use configurable `render_timeout_ms` (`PDFIUM_RENDER_TIMEOUT_MS`) with a
provisional 30,000 ms default and validated 1,000–120,000 ms range. Keep the
2,000 ms worker shutdown grace as a separate app-exit-only setting. Tune the
render deadline from measured dispatch-to-result tail latency and
false-timeout/restart rates over the fixed corpus; both timeout handling and
child exit/reap waits remain off the GUI thread.

The worker process is selected over a thread-only worker because a native
crash/hang cannot be safely cancelled as an ordinary Rust task. The supervisor
can terminate and reap the process, letting Windows reclaim its entire address
space, then start a fresh worker. This costs another process and must be
measured. Ordinary document close still does not promise immediate working-set
reduction.

## Consequences

- The steady-state renderer has one native engine and one active document.
- PDFium calls cannot block the Tauri command/runtime thread.
- A worker crash can be isolated and recovered without retaining its native
  address space, subject to bounded restart policy.
- Process IPC and packaging add complexity. Payload sizes and queues must be
  bounded and versioned.
- No claim about memory savings or leaks is accepted without measurement.

## Sources

- [`pdfium-render` documentation and feature/version notes](https://docs.rs/pdfium-render/latest/pdfium_render/)
- [PDFium binary distributions](https://github.com/bblanchon/pdfium-binaries)
- [PDFium binary releases](https://github.com/bblanchon/pdfium-binaries/releases)
- [PDFium upstream license](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE)
- [Tauri 2 Windows prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri 2 Windows installer and WebView2 modes](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri 2 resource bundling](https://v2.tauri.app/develop/resources/)
- [Tauri 2 sidecar packaging and launch](https://v2.tauri.app/develop/sidecar/)
- [Tauri 2 calling Rust and raw IPC responses](https://v2.tauri.app/develop/calling-rust/)
- [`Pdfium::bind_to_library`](https://docs.rs/pdfium-render/latest/pdfium_render/prelude/struct.Pdfium.html#method.bind_to_library)
- [Microsoft Visual C++ deployment guidance](https://learn.microsoft.com/en-us/cpp/windows/deployment-in-visual-cpp?view=msvc-170)

