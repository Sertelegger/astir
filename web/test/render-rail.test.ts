import { describe, it, expect, beforeEach } from "vitest";
import { renderRail } from "../src/render-rail.js";
import type { AgentRecordDTO } from "../src/protocol.js";

const agents: AgentRecordDTO[] = [
  { id: "s1", provider: "claude", name: "main", agentType: null, parentId: null, parentInferred: false, state: "thinking", now: "Planning the relay", nowSource: "reasoning", color: "#60a5fa", currentFiles: [] },
  { id: "subA", provider: "claude", name: "Explore", agentType: "Explore", parentId: "s1", parentInferred: false, state: "tool-running", now: "Searching for hooks", nowSource: "template", color: "#e879f9", currentFiles: ["src/a.ts"] },
];
let el: HTMLElement;
beforeEach(() => { el = document.createElement("div"); });

describe("renderRail", () => {
  it("one row per agent, nested by parentId, with color/state/now", () => {
    renderRail(el, agents);
    expect(el.querySelectorAll("[data-agent]")).toHaveLength(2);
    const sub = el.querySelector('[data-agent="subA"]') as HTMLElement;
    expect(sub.textContent).toContain("Searching for hooks");
    expect(sub.textContent).toContain("Explore");
    expect(sub.getAttribute("data-parent")).toBe("s1");
    expect((sub.querySelector("[data-dot]") as HTMLElement).style.background).toBeTruthy();
    expect(sub.style.marginLeft).not.toBe("");
  });
  it("main agent (parentId null) not indented", () => {
    renderRail(el, agents);
    const main = el.querySelector('[data-agent="s1"]') as HTMLElement;
    expect(main.style.marginLeft === "" || main.style.marginLeft === "0px").toBe(true);
  });
});
