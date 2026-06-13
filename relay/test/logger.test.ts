import { describe, it, expect } from "vitest";
import { Counters, RingLog } from "../src/log/logger.js";

describe("observability", () => {
  it("counters increment and snapshot", () => {
    const c = new Counters();
    c.inc("eventsIngested"); c.inc("eventsIngested"); c.inc("eventsDropped");
    expect(c.snapshot()).toMatchObject({ eventsIngested: 2, eventsDropped: 1 });
  });
  it("ring log caps total bytes (REQ-093) and never stores reasoning text (REQ-091)", () => {
    const log = new RingLog(200); // tiny cap
    for (let i = 0; i < 100; i++) log.line(`event ${i} tool=Edit path=src/a.ts`);
    expect(log.bytes()).toBeLessThanOrEqual(200);
    expect(log.dump()).not.toContain("event 0"); // oldest evicted
  });
});
