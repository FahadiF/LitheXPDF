# LitheXPDF

A lightweight Windows PDF reader planned for 30 or more open tabs. LitheXPDF
uses Rust stable, Tauri 2, vanilla TypeScript/HTML/CSS, and PDFium through
`pdfium-render`. The frontend never calls PDFium: the Rust backend owns the
document lifecycle and rendering.

**Working tagline:** Light on memory. Fast through documents.

The product and repository names remain provisional until repository-name
availability and relevant trademark checks are complete.

This repository is at the planning and environment-verification stage. No
application code or runtime claims have been made yet.

## Architecture and policy

- [Architecture](docs/ARCHITECTURE.md) describes tab states, worker ownership,
  and shutdown/recovery.
- [Memory policy](docs/MEMORY_POLICY.md) defines proposed limits and how to
  measure them. Limits are design targets, not measured results.
- [Render protocol](docs/RENDER_PROTOCOL.md) defines bounded requests,
  generations, stale-result rejection, and image ownership.
- [Testing plan](docs/TESTING.md) lists milestones and acceptance criteria.
- [Architecture decisions](docs/adr/) records the initial decisions.

## Environment snapshot

Verified on 2026-10-12 in the current Windows workspace:

- Node.js `v26.5.1`, npm `11.17.0`, and pnpm `11.25.0` are available.
- Git `2.56.0.windows.2` is available in the current repository.
- Windows reports kernel version `10.0.26200`; the registry identifies the
  product as Windows 10 Pro, 25H2 (build 26200.9550).
- Rust, Cargo, and rustup are not available on `PATH`.
- Tauri CLI (`tauri` / `cargo-tauri`) is not available.
- Rust bootstrap could not start because outbound download access is blocked in
  this environment.
- Visual Studio Build Tools 2026 (`18.8.2`) are installed. MSVC x64 compiler
  and linker files are present, and Windows SDK `10.0.26100.0` is installed.
- WebView2 Runtime `154.0.4258.62` is installed.
- No CMake, Ninja, or vcpkg command was found. They are not prerequisites for
  consuming a prebuilt PDFium DLL, but may be needed for a source-build path.
- Tauri MSI creation may additionally require the Windows VBScript optional
  feature. Its state could not be queried without elevation.

The machine inventory is not a substitute for a successful Tauri dev launch
and Windows bundle build. Rust and the Tauri CLI are the current blockers for
the environment and compatibility milestone. See the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/).

## Planned source layout

The environment and compatibility milestone should establish this structure without
adding a frontend framework:

```text
.
├── docs/
│   └── adr/
├── src/                         # vanilla TypeScript, HTML, CSS
├── crates/
│   └── pdfium-worker/           # separate Rust worker binary crate
├── src-tauri/
│   ├── binaries/                # Tauri sidecar target-triple artifact
│   ├── capabilities/
│   ├── resources/pdfium/        # pinned DLL and redistribution notices
│   ├── Cargo.toml               # Tauri host package; workspace member
│   ├── tauri.conf.json          # Tauri CLI marker and bundle configuration
│   └── src/                     # Tauri host and worker supervisor
├── Cargo.toml                   # repository-root Cargo workspace
├── package.json
├── tsconfig.json
└── vite.config.ts
```

The root `Cargo.toml` must declare `src-tauri` and `crates/pdfium-worker` as
workspace members (`resolver = "2"`). This is the single workspace arrangement
used by the commands in `docs/TESTING.md`; do not create a second, nested Cargo
workspace. The repository currently has neither that manifest nor the host and
worker package manifests, so this requirement is documented but not yet
verified against buildable Cargo metadata. The root `package.json` owns the
vanilla TypeScript frontend and Tauri CLI scripts. Run Cargo checks/tests from
the repository root, and invoke the Tauri CLI there so it discovers
`src-tauri/tauri.conf.json` in the standard Tauri project layout.

The required root workspace stanza is:

```toml
[workspace]
resolver = "2"
members = ["src-tauri", "crates/pdfium-worker"]
default-members = ["src-tauri", "crates/pdfium-worker"]
```

The initial render timeout is a configurable 30,000 ms test default, separate
from the 2,000 ms worker shutdown grace period. Both values remain provisional
until latency and recovery measurements are recorded; see
[Architecture](docs/ARCHITECTURE.md) and [Testing](docs/TESTING.md).

Worker packaging, binary transport, and the exact PDFium binary/API pairing
are defined in [Architecture](docs/ARCHITECTURE.md) and remain subject to the
compatibility spike in [ADR 0001](docs/adr/0001-tauri-rust-pdfium.md).

