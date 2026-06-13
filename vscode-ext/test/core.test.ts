import { describe, it, expect } from "vitest";
import { webviewParams } from "../src/webview.js";
import { handleWebviewMessage } from "../src/messages.js";

describe("webviewParams", () => {
  it("builds a query string with port, token, session", () => {
    const q = new URLSearchParams(webviewParams({ port: 51000, token: "tok" }, "s1"));
    expect(q.get("port")).toBe("51000");
    expect(q.get("token")).toBe("tok");
    expect(q.get("session")).toBe("s1");
  });
});
describe("handleWebviewMessage", () => {
  it("routes open-file to deps.openFile", () => {
    const opened: string[] = [];
    handleWebviewMessage({ type: "open-file", path: "src/a.ts" }, { openFile: (p) => opened.push(p) });
    expect(opened).toEqual(["src/a.ts"]);
  });
  it("ignores unknown/malformed messages", () => {
    const opened: string[] = [];
    const d = { openFile: (p: string) => opened.push(p) };
    handleWebviewMessage({ type: "nope" }, d);
    handleWebviewMessage({ type: "open-file" }, d);   // missing path
    handleWebviewMessage(null, d);
    handleWebviewMessage("x", d);
    expect(opened).toEqual([]);
  });
});
