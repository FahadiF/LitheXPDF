import { beforeEach, describe, expect, it } from "vitest";
import { initializeScaffold, SCAFFOLD_STATUS_TEXT } from "./scaffold";

describe("frontend scaffold", () => {
  beforeEach(() => {
    document.body.innerHTML = '<p id="scaffold-status"></p>';
  });

  it("labels the shell as a scaffold and does not imply PDF rendering works", () => {
    const status = document.querySelector<HTMLElement>("#scaffold-status");

    initializeScaffold(document);

    expect(status).not.toBeNull();
    expect(status?.textContent).toBe(SCAFFOLD_STATUS_TEXT);
    expect(status?.textContent).toContain("not implemented");
  });
});
