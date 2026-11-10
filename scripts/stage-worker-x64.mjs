import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDirectory = process.env.CARGO_TARGET_DIR
  ? resolve(repositoryRoot, process.env.CARGO_TARGET_DIR)
  : resolve(repositoryRoot, "target");
const source = resolve(
  targetDirectory,
  "x86_64-pc-windows-msvc/release/pdfium-worker.exe",
);
const destination = resolve(
  repositoryRoot,
  "src-tauri/binaries/pdfium-worker-x86_64-pc-windows-msvc.exe",
);

try {
  await access(source);
} catch {
  console.error(
    "Worker artifact is missing. Run `pnpm worker:build:windows` first.",
  );
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  console.log(`Staged Windows sidecar at ${destination}`);
}
