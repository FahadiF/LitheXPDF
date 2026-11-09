import "./styles.css";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import brandIconUrl from "../src-tauri/icons/lithexpdf.png";
import { PdfReaderUi } from "./reader";
import { installThemeToggle } from "./theme";

document.querySelectorAll<HTMLImageElement>("img[data-brand-icon]").forEach((image) => {
  image.src = brandIconUrl;
});
const favicon = document.querySelector<HTMLLinkElement>("#app-favicon");
if (favicon) favicon.href = brandIconUrl;

const reader = new PdfReaderUi(document, {
  isDesktop: isTauri(),
  pickPdf: () => open({ multiple: true, directory: false, filters: [{ name: "PDF documents", extensions: ["pdf"] }] }),
  invoke: (command, args) => invoke(command, args),
});
if (isTauri()) {
  void invoke<string | null>("take_startup_pdf_path")
    .then((path) => { if (path) return reader.open(path); })
    .catch((error: unknown) => console.error("Unable to open the PDF passed to LitheXPDF.", error));
}
installThemeToggle(document.documentElement, (() => {
  try { return window.localStorage; } catch { return undefined; }
})());

installWindowChrome();

function installWindowChrome(): void {
  if (!isTauri()) return;

  document.documentElement.dataset.windowChrome = "custom";

  const appWindow = getCurrentWindow();
  const titlebar = document.querySelector<HTMLElement>(".topbar");
  const minimizeButton = document.querySelector<HTMLButtonElement>("#window-minimize");
  const maximizeButton = document.querySelector<HTMLButtonElement>("#window-maximize");
  const closeButton = document.querySelector<HTMLButtonElement>("#window-close");
  if (!titlebar || !minimizeButton || !maximizeButton || !closeButton) return;

  const reportWindowError = (operation: string, error: unknown): void => {
    console.error(`Unable to ${operation} the LitheXPDF window.`, error);
  };

  const syncMaximizeState = async (): Promise<void> => {
    try {
      const maximized = await appWindow.isMaximized();
      maximizeButton.setAttribute("aria-label", maximized ? "Restore window" : "Maximize window");
      maximizeButton.title = maximized ? "Restore" : "Maximize";
      maximizeButton.closest<HTMLElement>(".window-controls")?.setAttribute("data-maximized", String(maximized));
    } catch (error) {
      reportWindowError("read the window state for", error);
    }
  };

  minimizeButton.addEventListener("click", () => {
    void appWindow.minimize().catch((error: unknown) => reportWindowError("minimize", error));
  });
  maximizeButton.addEventListener("click", () => {
    void appWindow.toggleMaximize()
      .then(syncMaximizeState)
      .catch((error: unknown) => reportWindowError("maximize or restore", error));
  });
  closeButton.addEventListener("click", () => {
    void appWindow.close().catch((error: unknown) => reportWindowError("close", error));
  });

  titlebar.addEventListener("dblclick", (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("button, input, select, textarea, a, [role='button'], .menu-wrap, .toolbar")) return;
    if (target !== titlebar && !target.closest("[data-tauri-drag-region]")) return;
    void appWindow.toggleMaximize()
      .then(syncMaximizeState)
      .catch((error: unknown) => reportWindowError("maximize or restore", error));
  });

  void appWindow.onResized(() => { void syncMaximizeState(); })
    .catch((error: unknown) => reportWindowError("subscribe to window resizing for", error));
  void syncMaximizeState();
}
