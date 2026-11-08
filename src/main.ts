import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { PdfReaderUi } from "./reader";
import { installThemeToggle } from "./theme";

new PdfReaderUi(document, {
  pickPdf: () => open({ multiple: false, directory: false, filters: [{ name: "PDF documents", extensions: ["pdf"] }] }),
  invoke: (command, args) => invoke(command, args),
});
installThemeToggle(document.documentElement, (() => {
  try { return window.localStorage; } catch { return undefined; }
})());
