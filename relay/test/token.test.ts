import { describe, it, expect } from "vitest";
import { generateToken, constantTimeEqual } from "../src/security/token.js";

describe("token", () => {
  it("generates a >=128-bit hex token (>=32 hex chars)", () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]+$/);
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(generateToken()).not.toEqual(t);
  });
  it("constantTimeEqual matches equal strings and rejects unequal", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
