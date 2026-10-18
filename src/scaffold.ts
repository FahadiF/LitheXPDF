export const SCAFFOLD_STATUS_TEXT =
  "Desktop shell scaffold. PDF rendering is not implemented.";

export function initializeScaffold(root: ParentNode): void {
  const status = root.querySelector<HTMLElement>("#scaffold-status");

  if (status) {
    status.textContent = SCAFFOLD_STATUS_TEXT;
  }
}
