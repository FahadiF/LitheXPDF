# Testing and release checklist

This document describes how to verify a build before publishing a release.

---

## CI checks (automated)

The following must pass on every commit to `main` and on all pull requests:

| Check | Command |
|---|---|
| TypeScript type check | `npx tsc --noEmit` |
| Frontend production build | `pnpm build` |
| Rust format | `cargo fmt --all -- --check` |
| Rust compile (all targets) | `cargo check --workspace --all-targets --target x86_64-pc-windows-msvc` |
| Rust unit tests | `cargo test --workspace` |
| Frontend unit tests | `pnpm test` |

---

## Release checklist

Run these steps before tagging and publishing a release:

### 1. Build both installers

```powershell
# x64 (required)
pnpm release:msi:x64

# x86 (required for multi-arch release)
pnpm release:msi:x86
```

Confirm both commands exit 0 and produce MSI files in:
- `target\x86_64-pc-windows-msvc\release\bundle\msi\`
- `target\i686-pc-windows-msvc\release\bundle\msi\`

### 2. Installer smoke test

Install the x64 MSI on a development machine (not a VM):

- [ ] Installer completes without errors
- [ ] Application launches from Start menu
- [ ] Application icon appears correctly in taskbar and Start
- [ ] Uninstall via **Apps & features** completes without errors

> [!CAUTION]
> Uninstall has previously failed on non-C: install paths due to a Windows Installer ACL issue (error 1310, system error 1307). If this reproduces, do not publish until resolved. Use `msiexec /x {product-code} /l*v uninstall.log` to capture a verbose log.

### 3. Manual PDF reading test

Open each of the following PDF types and verify rendering is correct:

- [ ] Short document (1–10 pages) — text-based
- [ ] Long document (100+ pages) — test continuous scroll, page jump, search
- [ ] Scanned / image-only PDF — pages should display, text selection returns nothing
- [ ] Mixed-dimension PDF — pages of different sizes
- [ ] Corrupt or truncated PDF — should show an error, not crash

### 4. Text selection

- [ ] Click-drag on a text page selects text (blue highlight visible)
- [ ] Ctrl+C copies the selected text; paste into Notepad confirms content

### 5. Session restore

- [ ] Open 3+ tabs, close the app, reopen — all tabs restore with correct scroll positions
- [ ] Disabling session restore in Options → reopening shows no restored tabs

### 6. Tab management

- [ ] Drag a tab to a new position — tab order updates correctly
- [ ] Right-click menu shows all options; each action works correctly
- [ ] Show in Explorer opens Windows Explorer with the file highlighted

### 7. Search

- [ ] Ctrl+F opens the search bar
- [ ] Matches are highlighted across pages; next/previous navigation works
- [ ] Case-sensitive and whole-word toggles work correctly

### 8. Print

- [ ] Ctrl+P opens the LitheXPDF page selector
- [ ] Current page, all pages, and a custom range (e.g., `3-8`) produce the correct page count in the Windows printer dialog
- [ ] Invalid ranges (reversed, out-of-bounds) are rejected with a clear message

### 9. File association

- [ ] After install, LitheXPDF appears in Windows **Default apps** as an option for `.pdf`
- [ ] Setting LitheXPDF as default → double-clicking a PDF in Explorer opens it in the app

### 10. Themes

- [ ] Dark theme renders correctly
- [ ] Light theme renders correctly
- [ ] Manual toggle in Options switches immediately

---

## Known issues

| Issue | Status |
|---|---|
| Uninstall fails on some non-C: install paths (Windows Installer ACL error 1310) | Under investigation — do not suppress without root cause |
| Explorer thumbnail integration not implemented | Planned for a future release |
| Encrypted PDFs not supported | Planned for a future release |
| Installers are unsigned — SmartScreen warning on first run | Will be resolved with a code-signing certificate |
