# ADR 0001: Tauri, Rust, and PDFium

- Status: Accepted for worker-only smoke integration; clean packaged execution
  and production host/worker integration remain open.
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
- `pdfium-render` 0.9.4 exposes explicit `pdfium_7881` and related binding
  features; its default `pdfium_latest` currently aliases `pdfium_7881`. It
  does not expose a numbered binding for the newer 8086 build used in the
  worker smoke test. The worker disables default features and pins
  `pdfium_7881`, `image_025`, and `thread_safe` explicitly. Never follow a
  floating `latest` DLL or API feature in a reproducible build.
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
  and its notices. The selected archive contains its root `LICENSE` and 17
  files under `licenses/`; those actual texts are concatenated into the
  bundled `THIRD_PARTY_NOTICES.txt` with source-file headings. The archive's
  own notice files must be refreshed and rechecked on any runtime upgrade.
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

The current worker smoke-test selection is official bblanchon release
`chromium/8086`, PDFium `157.0.8086.0`, commit
`5325fa6d0d9379329f10f98fdc4839b4e40f2e79`, asset
`pdfium-win-x64.tgz`. GitHub's release API digest and the locally computed
archive SHA-256 both equal
`1fd8af952832dbb0eb16d9249f68fe09e5f5ebf7c3dd9f6066ea2720cc28487d`. The
locally computed extracted `pdfium.dll` SHA-256 is
`1f2aee4286b8cf0413ab4562b7121aa454f9cfd9afd6ca8609bcef80927b3f80`.
With the `pdfium_7881` binding, the worker's real fixture subprocess test
loaded this newer x64 DLL, opened a one-page PDF, reported its 200×120 point
page, rendered a 200×120 PNG, and exited successfully. This proves the tested
function path only; it is not a claim that every newer API binding call or a
packaged Tauri load works. The exact release facts and dumpbin imports are in
`docs/TESTING.md`.

The repository-root `Cargo.toml` is the single workspace manifest with
`resolver = "2"` and members `src-tauri` and `crates/pdfium-worker`; the host's
Tauri marker/config remains `src-tauri/tauri.conf.json`. Build the sidecar
from the root with
`cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker`, then
stage its `.exe` at the target-triple-suffixed path above. The canonical DLL
resource mapping is
`src-tauri/resources/pdfium/pdfium.dll` → `pdfium/pdfium.dll`, with notices at
`src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt` →
`pdfium/THIRD_PARTY_NOTICES.txt`. These mappings are now active in Tauri
configuration. Resolve the DLL through `BaseDirectory::Resource`; never use
the process working directory. The host resolver and packaged execution have
not yet been implemented or tested.

Within the worker, one OS thread owns the PDFium library and at most one
document; serialize all operations. Host/worker messages use bounded,
versioned binary frames over raw sidecar stdin/stdout: 20-byte `PDFW` header,
version 1, big-endian fields, 64 KiB control/request payload cap, and a 32 MiB
encoded-image cap plus at most 4 KiB metadata. WebView render calls return the
framed image as `tauri::ipc::Response::new(Vec<u8>)` and
`@tauri-apps/api/core` `invoke()` receives an `ArrayBuffer`; small metadata may
use JSON events. Never transport large image payloads as JSON. Package a
The exact worker crate/API/binary tuple, archive and DLL hashes, and local
dynamic load/open/render/close smoke path have passed. Keep clean-machine
runtime dependency checks, Tauri resource lookup, packaged loading, and
installer verification as release gates.

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

