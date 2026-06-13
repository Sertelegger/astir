export interface ChromeModel {
  breadcrumb: string[];
  status: "connected" | "reconnecting" | "unreachable";
  sessionState: "live" | "ended" | "unreachable" | null;
  provider: string | null;
  specs: string[];
}
export interface ChromeCallbacks { onCrumb: (path: string) => void; onSpec: (path: string) => void; }

export function renderChrome(el: HTMLElement, m: ChromeModel, cb: ChromeCallbacks): void {
  el.innerHTML = "";
  // status + provider
  const status = document.createElement("div");
  const sess = m.sessionState === "ended" ? "session ended" : m.sessionState === "unreachable" ? "relay unreachable" : m.status;
  status.textContent = `${m.provider ?? "?"} · ${sess}`;
  el.appendChild(status);
  // breadcrumb: root + each segment, click yields cumulative path
  const bc = document.createElement("div");
  const mkCrumb = (label: string, path: string): HTMLElement => {
    const s = document.createElement("span");
    s.setAttribute("data-crumb", path);
    s.textContent = label === "" ? "repo" : ` / ${label}`;
    s.style.cursor = "pointer";
    s.addEventListener("click", () => cb.onCrumb(path));
    return s;
  };
  bc.appendChild(mkCrumb("", ""));
  let acc = "";
  for (const seg of m.breadcrumb) { acc = acc === "" ? seg : `${acc}/${seg}`; bc.appendChild(mkCrumb(seg, acc)); }
  el.appendChild(bc);
  // spec list (most-recent first; click → open)
  const specs = document.createElement("div");
  for (const p of m.specs) {
    const s = document.createElement("div");
    s.setAttribute("data-spec", p);
    s.textContent = p;
    s.style.cursor = "pointer";
    s.addEventListener("click", () => cb.onSpec(p));
    specs.appendChild(s);
  }
  el.appendChild(specs);
}
