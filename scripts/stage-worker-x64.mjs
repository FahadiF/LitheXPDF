import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDirectory = process.env.CARGO_TARGET_DIR
  ? resolve(repositoryRoot, process.env.CARGO_TARGET_DIR)
  : resolve(repositoryRoot, "target");

const workerSource = resolve(
  targetDirectory,
  "x86_64-pc-windows-msvc/release/pdfium-worker.exe",
);
const workerDestination = resolve(
  repositoryRoot,
  "src-tauri/binaries/pdfium-worker-x86_64-pc-windows-msvc.exe",
);

const pdfiumSource = resolve(
  repositoryRoot,
  "src-tauri/resources/pdfium-x64/pdfium.dll",
);
const pdfiumDestination = resolve(
  repositoryRoot,
  "src-tauri/resources/pdfium/pdfium.dll",
);

async function verifyArch(filePath, expectedMachine) {
  const buf = await readFile(filePath);
  const peOffset = buf.readUInt32LE(0x3c);
  const machine = buf.readUInt16LE(peOffset + 4);
  if (machine !== expectedMachine) {
    throw new Error(
      `Architecture mismatch for ${filePath}: expected 0x${expectedMachine.toString(16)}, found 0x${machine.toString(16)}`,
    );
  }
}

try {
  await access(workerSource);
  await verifyArch(workerSource, 0x8664);
} catch (e) {
  console.error(`x64 Worker artifact check failed: ${e.message}`);
  process.exitCode = 1;
}

try {
  await access(pdfiumSource);
  await verifyArch(pdfiumSource, 0x8664);
} catch (e) {
  console.error(`x64 PDFium DLL check failed: ${e.message}`);
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  await mkdir(dirname(workerDestination), { recursive: true });
  await copyFile(workerSource, workerDestination);
  console.log(`Staged x64 sidecar at ${workerDestination}`);

  await copyFile(pdfiumSource, pdfiumDestination);
  console.log(`Staged x64 PDFium DLL at ${pdfiumDestination}`);
}
