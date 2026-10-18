import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { PdfReaderUi } from "./reader";

new PdfReaderUi(document, {
  pickPdf: () => open({ multiple: false, directory: false, filters: [{ name: "PDF documents", extensions: ["pdf"] }] }),
  invoke: (command, args) => invoke(command, args),
});
