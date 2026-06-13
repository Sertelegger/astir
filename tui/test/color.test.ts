import { describe, it, expect } from "vitest";
import { detectColorMode, heatBlock } from "../src/color.js";

describe("color", () => {
  it("detectColorMode: NO_COLOR/dumb → mono, COLORTERM truecolor → truecolor, else 256", () => {
    expect(detectColorMode({ NO_COLOR: "1" })).toBe("mono");
    expect(detectColorMode({ TERM: "dumb" })).toBe("mono");
    expect(detectColorMode({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(detectColorMode({ TERM: "xterm-256color" })).toBe("256");
    expect(detectColorMode({})).toBe("256");
  });
  it("heatBlock: mono has NO ansi escapes; truecolor encodes 24-bit; idle is dim/blank", () => {
    expect(heatBlock(0.9, "mono")).not.toMatch(/\x1b\[/);
    expect(heatBlock(1, "truecolor")).toContain("38;2;255;90;40");
    expect(heatBlock(0, "truecolor")).not.toContain("38;2;255"); // idle not hot-colored
    expect(heatBlock(0.5, "256")).toMatch(/\x1b\[38;5;\d+m/);
  });
});
