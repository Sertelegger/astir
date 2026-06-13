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
});
