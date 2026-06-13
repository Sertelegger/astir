export type Shape = "sunburst" | "treemap";

/** Focus = currently-zoomed subtree path ("" = whole repo). Shape persistence per REQ-045. */
export class ViewState {
  focus = "";
  private shape: Shape = "sunburst";
  private sticky = false;

  shapeFor(): Shape {
    if (this.sticky) return this.shape;
    return this.focus === "" ? "sunburst" : "treemap";
  }
  zoomTo(path: string): void { this.focus = path; }
  zoomOut(toPath = ""): void { this.focus = toPath; }
  toggle(): void {
    const current = this.shapeFor();
    this.sticky = true;
    this.shape = current === "sunburst" ? "treemap" : "sunburst";
  }
  breadcrumb(): string[] { return this.focus === "" ? [] : this.focus.split("/"); }
}
