import { App } from "./app.js";
import { SseClient } from "./sse-client.js";
import { BrowserHost, VscodeHost, type Host } from "./host.js";

const params = new URLSearchParams(location.search);
const port = params.get("port") ?? "0";
const token = params.get("token") ?? "";
const sessionId = params.get("session") ?? "";
const root = document.getElementById("app")!;

// VSCode injects `acquireVsCodeApi`; otherwise we're a plain browser.
const vscode = (globalThis as { acquireVsCodeApi?: () => { postMessage(m: unknown): void } }).acquireVsCodeApi?.();
const host: Host = vscode
  ? new VscodeHost((m) => vscode.postMessage(m))
  : new BrowserHost((msg) => { const t = document.createElement("div"); t.textContent = msg; t.style.cssText = "position:fixed;bottom:12px;left:12px;background:#222;padding:6px 10px;border-radius:6px;"; root.appendChild(t); setTimeout(() => t.remove(), 1500); });

const app = new App(root, sessionId, host);
window.addEventListener("keydown", (e) => { if (e.key.toLowerCase() === "t") app.toggleShape(); });
const sse = new SseClient({
  url: `http://127.0.0.1:${port}/stream`, token,
  onFrame: (f) => app.onFrame(f),
  onStatus: (s) => app.setStatus(s),
});
sse.start();
