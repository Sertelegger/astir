import { describe, it, expect, beforeEach } from "vitest";
import { renderChrome, type ChromeModel } from "../src/render-chrome.js";

let el: HTMLElement;
beforeEach(() => { el = document.createElement("div"); });
const model: ChromeModel = { breadcrumb: ["src", "auth"], status: "connected", sessionState: "live", provider: "claude", specs: ["docs/x.md"] };

describe("renderChrome", () => {
  it("renders breadcrumb segments incl. a root crumb; click yields cumulative path", () => {
    let crumb: string | null = null;
    renderChrome(el, model, { onCrumb: (p) => (crumb = p), onSpec: () => {} });
    const crumbs = el.querySelectorAll("[data-crumb]");
    expect(crumbs.length).toBe(3); // root + src + auth
    (el.querySelector('[data-crumb="src"]') as HTMLElement).dispatchEvent(new Event("click"));
    expect(crumb).toBe("src");
    (el.querySelector('[data-crumb=""]') as HTMLElement).dispatchEvent(new Event("click"));
    expect(crumb).toBe(""); // root
  });
  it("shows status + provider, and a clickable spec list", () => {
    let spec = "";
    renderChrome(el, model, { onCrumb: () => {}, onSpec: (p) => (spec = p) });
    expect(el.textContent).toContain("connected");
    expect(el.textContent).toContain("claude");
    (el.querySelector('[data-spec="docs/x.md"]') as HTMLElement).dispatchEvent(new Event("click"));
    expect(spec).toBe("docs/x.md");
  });
});
