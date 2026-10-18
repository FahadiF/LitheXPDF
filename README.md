# LitheXPDF

A lightweight Windows PDF reader planned for 30 or more open tabs. LitheXPDF
uses Rust stable, Tauri 2, vanilla TypeScript/HTML/CSS, and PDFium through
`pdfium-render`. The frontend never calls PDFium: the Rust backend owns the
document lifecycle and rendering.

**Light on memory. Fast through documents.**

Milestone 1 now connects the vanilla UI to an asynchronous Tauri host command,
the target-triple-named worker sidecar, bounded versioned binary IPC, and a raw
Tauri `ArrayBuffer` response. The first vertical slice opens one local PDF,
renders a page, supports previous/next navigation, and closes the active
document. Multiple tabs, clean-machine packaging, and broad document coverage
remain future work. The selected PDFium 8086 / `pdfium-render` 0.9.4 /
`pdfium_7881` pairing remains an acknowledged compatibility limitation.

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
- The global Tauri CLI is not on `PATH`; project-local `@tauri-apps/cli`
  `2.12.2` is available through pnpm.
- A prior rustup bootstrap attempt was blocked by outbound network restrictions;
  Rust installation was not retried during this scaffold task.
- Visual Studio Build Tools 2026 (`18.8.2`) are installed. MSVC x64 compiler
  and linker files are present, and Windows SDK `10.0.26100.0` is installed.
- WebView2 Runtime `154.0.4258.62` is installed.
- No CMake, Ninja, or vcpkg command was found. They are not prerequisites for
  consuming a prebuilt PDFium DLL, but may be needed for a source-build path.
- Tauri MSI creation may additionally require the Windows VBScript optional
  feature. Its state could not be queried without elevation.

The machine inventory is not a substitute for a successful Tauri dev launch
and Windows bundle build. This is a historical snapshot of 2026-10-12. Current
toolchain checks and Tauri window verification are recorded in
[Testing](docs/TESTING.md). See the
[Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/).

## Source layout

The current scaffold follows this layout without a frontend framework:

```text
.
├── docs/
│   └── adr/
├── src/                         # vanilla TypeScript, HTML, CSS
├── index.html
├── crates/
│   ├── pdfium-protocol/         # shared bounded host/worker frame codec
│   └── pdfium-worker/           # separate Rust binary; sole PDFium owner
├── src-tauri/
│   ├── binaries/                # target-triple sidecar staged after build
│   ├── capabilities/            # minimal Tauri capability
│   ├── resources/pdfium/        # hash-pinned DLL and its actual release notices
│   ├── Cargo.toml               # Tauri host package; workspace member
│   ├── tauri.conf.json          # Tauri CLI marker and bundle configuration
│   └── src/                     # async host/supervisor; no PDFium dependency
├── scripts/                     # deterministic Windows sidecar staging
├── Cargo.toml                   # repository-root Cargo workspace
├── Cargo.lock                   # workspace dependency lockfile
├── package.json
├── pnpm-workspace.yaml          # allowBuilds for esbuild only
├── pnpm-lock.yaml
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts
```

The root `Cargo.toml` declares `src-tauri` and `crates/pdfium-worker` as
workspace members (`resolver = "2"`); there is no nested workspace. The root
`package.json` owns the vanilla TypeScript frontend, test, and Tauri CLI
scripts. The host uses Tauri 2 and the shell plugin, but does not link
`pdfium-render`. The worker is a separate binary and owns the diagnostic
PDFium path. `pnpm worker:build:windows` builds the x64 MSVC target;
`pnpm worker:stage:windows` stages the target-triple-named sidecar. The Rust
`Cargo.lock` is present; the environment snapshot above predates its current
verification.

The required root workspace stanza is:

```toml
[workspace]
resolver = "2"
members = ["src-tauri", "crates/pdfium-worker"]
default-members = ["src-tauri", "crates/pdfium-worker"]
```

The provisional render timeout is 30,000 ms (`PDFIUM_RENDER_TIMEOUT_MS`,
clamped to 1,000–120,000 ms); application shutdown uses a separate 2,000 ms
grace. Runtime supervision is implemented off the GUI thread. No latency or
memory improvement is claimed; see [Testing](docs/TESTING.md) for what remains
unverified.

Worker packaging, binary transport, and the exact PDFium binary/API pairing
are defined in [Architecture](docs/ARCHITECTURE.md). The current worker-only
compatibility result and its limits are recorded in [Testing](docs/TESTING.md)
and [ADR 0001](docs/adr/0001-tauri-rust-pdfium.md).

