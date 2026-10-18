import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(
  repositoryRoot,
  "target/x86_64-pc-windows-msvc/release/pdfium-worker.exe",
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
