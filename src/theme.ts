export type Theme = "dark" | "light";

const THEME_KEY = "lithexpdf.theme";

export function installThemeToggle(root: HTMLElement, storage?: Storage): void {
  const button = root.querySelector<HTMLButtonElement>("#theme-toggle");
  if (!button) throw new Error("Missing UI element #theme-toggle");

  const stored = safeRead(storage);
  let theme: Theme = stored === "light" ? "light" : "dark";
  const apply = (): void => {
    root.dataset.theme = theme;
    button.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
    button.title = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;
    button.setAttribute("aria-pressed", String(theme === "light"));
  };

  apply();
  button.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    apply();
    try { storage?.setItem(THEME_KEY, theme); } catch { /* Theme still changes for this session. */ }
  });
}

function safeRead(storage?: Storage): string | null {
  try { return storage?.getItem(THEME_KEY) ?? null; } catch { return null; }
}
