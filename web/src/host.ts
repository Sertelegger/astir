/** Abstracts the host-side "open file" action (REQ-046). */
export interface Host { openFile(path: string): void; }

/** Plain browser: copy the repo-relative path and toast (a browser can't open editor files). */
export class BrowserHost implements Host {
  constructor(private toast: (msg: string) => void) {}
  openFile(path: string): void {
    try { void navigator.clipboard?.writeText(path); } catch { /* clipboard may be unavailable */ }
    this.toast(`Copied path: ${path}`);
  }
}

/** VSCode webview: postMessage to the extension host, which opens the file (P3). */
export class VscodeHost implements Host {
  constructor(private post: (msg: unknown) => void) {}
  openFile(path: string): void { this.post({ type: "open-file", path }); }
}
