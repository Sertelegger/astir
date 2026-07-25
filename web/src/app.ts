import type { Frame } from "./protocol.js";
import { Store } from "./store.js";
import { ViewState } from "./view-state.js";
import { computeLayout, type Size } from "./layout.js";
import { renderHeatmap } from "./render-heatmap.js";
import { renderRail } from "./render-rail.js";
import { renderChrome } from "./render-chrome.js";
import type { Host } from "./host.js";

export class App {
  private store: Store;
  private view = new ViewState();
  private status: "connected" | "reconnecting" | "unreachable" = "reconnecting";
  private chromeEl = document.createElement("div");
  private railEl = document.createElement("div");
  private svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

  constructor(root: HTMLElement, sessionId: string, private host: Host, private size: Size = { width: 800, height: 600 }) {
    this.store = new Store(sessionId);
    this.railEl.style.cssText = "width:220px;min-width:180px;overflow:auto;padding:8px;border-right:1px solid #222;";
    this.svg.setAttribute("width", "100%"); this.svg.setAttribute("height", "100%");
    const main = document.createElement("div"); main.style.cssText = "flex:1;display:flex;flex-direction:column;";
    const body = document.createElement("div"); body.style.cssText = "flex:1;display:flex;";
    body.append(this.railEl, this.svg);
    main.append(this.chromeEl, body); root.appendChild(main);
  }

  setStatus(s: "connected" | "reconnecting" | "unreachable"): void { this.status = s; this.render(); }
  /** Re-lay-out at a new viewport size (window / VSCode panel resize). */
  resize(size: Size): void { this.size = size; this.render(); }
  onFrame(f: Frame): void { this.store.apply(f); this.render(); }
  toggleShape(): void { this.view.toggle(); this.render(); }

  render(): void {
    const st = this.store.state;
    if (st.tree) {
      const shape = this.view.shapeFor();
      const nodes = computeLayout(st.tree, this.view.focus, shape, this.size);
      renderHeatmap(this.svg, nodes, { maxLeafHeat: st.maxLeafHeat, agents: st.agents, shape, size: this.size }, {
        onFile: (p) => this.host.openFile(p),
        onZoom: (p) => { this.view.zoomTo(p); this.render(); },
      });
      renderRail(this.railEl, st.agents);
    }
    renderChrome(this.chromeEl, { breadcrumb: this.view.breadcrumb(), status: this.status, sessionState: st.sessionState, provider: st.provider, specs: st.specs }, {
      onCrumb: (p) => { this.view.zoomOut(p); this.render(); },
      onSpec: (p) => this.host.openFile(p),
      onToggleShape: () => this.toggleShape(),
    });
  }
}
