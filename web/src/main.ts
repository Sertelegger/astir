import { App } from "./app.js";
import { SseClient } from "./sse-client.js";
import { BrowserHost, VscodeHost, type Host } from "./host.js";

const params = new URLSearchParams(location.search);
// Single-URL mode: when the relay serves this app itself the port is implicit,
// so `?token=…&session=…` is enough and we stream from the same origin.
const port = params.get("port") ?? "";
const streamUrl = port ? `http://127.0.0.1:${port}/stream` : new URL("/stream", location.origin).toString();
const token = params.get("token") ?? "";
const sessionId = params.get("session") ?? "";
const root = document.getElementById("app")!;

// VSCode injects `acquireVsCodeApi`; otherwise we're a plain browser.
const vscode = (globalThis as { acquireVsCodeApi?: () => { postMessage(m: unknown): void } }).acquireVsCodeApi?.();
const host: Host = vscode
  ? new VscodeHost((m) => vscode.postMessage(m))
  : new BrowserHost((msg) => { const t = document.createElement("div"); t.textContent = msg; t.style.cssText = "position:fixed;bottom:12px;left:12px;background:#222;padding:6px 10px;border-radius:6px;"; root.appendChild(t); setTimeout(() => t.remove(), 1500); });

const app = new App(root, sessionId, host);

/** Measure the heat-map viewport; ignore zero/NaN boxes (hidden panel, pre-layout). */
function measure(): { width: number; height: number } | null {
  const box = root.querySelector("svg") ?? root;
  const width = box.clientWidth || root.clientWidth || window.innerWidth;
  const height = box.clientHeight || root.clientHeight || window.innerHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}
function applySize(): void { const s = measure(); if (s) app.resize(s); }
applySize();

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applySize, 100); // debounce: dragging the window shouldn't thrash the layout
});

window.addEventListener("keydown", (e) => { if (e.key.toLowerCase() === "t") app.toggleShape(); });
const sse = new SseClient({
  url: streamUrl, token,
  onFrame: (f) => app.onFrame(f),
  onStatus: (s) => app.setStatus(s),
});
sse.start();
