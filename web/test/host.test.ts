import { describe, it, expect, vi } from "vitest";
import { BrowserHost, VscodeHost } from "../src/host.js";

describe("Host", () => {
  it("VscodeHost posts an open-file message", () => {
    const posted: unknown[] = [];
    new VscodeHost((m) => posted.push(m)).openFile("src/a.ts");
    expect(posted).toEqual([{ type: "open-file", path: "src/a.ts" }]);
  });
  it("BrowserHost toasts the copied path", () => {
    const toast = vi.fn();
    new BrowserHost(toast).openFile("src/a.ts");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("src/a.ts"));
  });
});
