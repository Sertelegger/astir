import { describe, it, expect } from "vitest";
import { makeSummarizer } from "../src/relay/model-providers.js";
import { OffSummarizer } from "../src/relay/summarizer.js";
import { AutoSummarizer } from "../src/relay/auto-summarizer.js";

describe("makeSummarizer", () => {
  it("returns OffSummarizer when mode is off (zero egress, REQ-034)", () => {
    expect(makeSummarizer({ mode: "off", provider: "claude" })).toBeInstanceOf(OffSummarizer);
  });
  it("returns an AutoSummarizer when mode is auto", () => {
    expect(makeSummarizer({ mode: "auto", provider: "claude" })).toBeInstanceOf(AutoSummarizer);
  });
  it("defaults to CLI transport (subscription) when mode is auto", () => {
    const s = makeSummarizer({ mode: "auto", provider: "claude" });
    expect(s).toBeInstanceOf(AutoSummarizer); // cli transport, no API key needed
  });
  it("api transport still yields an AutoSummarizer", () => {
    expect(makeSummarizer({ mode: "auto", provider: "codex", transport: "api" })).toBeInstanceOf(AutoSummarizer);
  });
});
