import { describe, it, expect } from "vitest";
import { OffSummarizer, egressFields, type SummarizerEvent } from "../src/relay/summarizer.js";

const evs: SummarizerEvent[] = [
  { kind: "post_tool", tool: "Edit", op: "edit", paths: ["src/auth/login.ts"] },
];

describe("summarizer seam", () => {
  it("OffSummarizer never produces output (off = zero egress, REQ-034)", async () => {
    const s = new OffSummarizer();
    expect(await s.summarize("agA", evs)).toBeNull();
  });
  it("egressFields includes only kind/tool/op/basename, never reasoning/payloads (REQ-036)", () => {
    const f = egressFields(evs);
    expect(f).toEqual([{ kind: "post_tool", tool: "Edit", op: "edit", basenames: ["login.ts"] }]);
    expect(JSON.stringify(f)).not.toContain("src/auth"); // full path not egressed
  });
});
