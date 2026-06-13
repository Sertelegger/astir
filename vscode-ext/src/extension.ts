/* c8 ignore start — VSCode-host glue; verified by running the extension in VSCode (human) */
import * as vscode from "vscode";
import { resolveWorkspaceRelay } from "./resolve.js";
import { webviewParams } from "./webview.js";
import { handleWebviewMessage } from "./messages.js";

export function activate(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand("clide.openActivityPanel", () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const panel = vscode.window.createWebviewPanel("clide", "Clide", vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    const relay = resolveWorkspaceRelay(folder);
    if (!relay) {
      panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
        </head><body style="font-family:sans-serif;padding:24px;color:#aaa;background:#0e1116">
        <h3>No active Clide session in this folder</h3>
        <p>Start a Claude Code or Codex session in this workspace, then reopen this panel.</p></body></html>`;
      return;
    }
    const idx = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "index.html"));
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${panel.webview.cspSource}; style-src 'unsafe-inline';">
      </head><body style="margin:0;background:#0e1116">
      <iframe src="${idx.toString()}?${webviewParams(relay, relay.sessionId)}" style="border:0;width:100vw;height:100vh"></iframe></body></html>`;
    panel.webview.onDidReceiveMessage((msg) => handleWebviewMessage(msg, {
      openFile: (p) => { void vscode.window.showTextDocument(vscode.Uri.file(p)); },
    }), undefined, context.subscriptions);
  });
  context.subscriptions.push(cmd);
}
export function deactivate(): void { /* nothing to clean up */ }
/* c8 ignore stop */
