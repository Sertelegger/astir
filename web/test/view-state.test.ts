import { describe, it, expect } from "vitest";
import { ViewState } from "../src/view-state.js";

describe("ViewState", () => {
  it("default shape per focus until a manual toggle makes it sticky (REQ-045)", () => {
    const v = new ViewState();
    expect(v.shapeFor()).toBe("sunburst");
    v.zoomTo("src"); expect(v.shapeFor()).toBe("treemap");
    v.toggle(); expect(v.shapeFor()).toBe("sunburst");
    v.zoomOut(); expect(v.shapeFor()).toBe("sunburst");
    v.zoomTo("src/auth"); expect(v.shapeFor()).toBe("sunburst");
  });
  it("zoom sets focus + breadcrumb; zoomOut resets", () => {
    const v = new ViewState();
    v.zoomTo("src/auth");
    expect(v.focus).toBe("src/auth");
    expect(v.breadcrumb()).toEqual(["src", "auth"]);
    v.zoomOut();
    expect(v.focus).toBe("");
    expect(v.breadcrumb()).toEqual([]);
  });
});
