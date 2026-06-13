/* c8 ignore start — VSCode-host glue; verified by running the extension in VSCode (human) */
import * as vscode from "vscode";
import { resolveWorkspaceRelay } from "./resolve.js";
import { webviewParams } from "./webview.js";
import { handleWebviewMessage } from "./messages.js";

export function activate(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand("clide.openActivityPanel", () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const panel = vscode.window.createWebviewPanel("clide", "Clide", vscode.ViewColumn.Beside, { enableScripts: true });
    const relay = resolveWorkspaceRelay(folder);
    if (!relay) {
      panel.webview.html = `<!doctype html><body style="font-family:sans-serif;padding:24px;color:#aaa;background:#0e1116">
        <h3>No active Clide session in this folder</h3>
        <p>Start a Claude Code or Codex session in this workspace, then reopen this panel.</p></body>`;
      return;
    }
    const idx = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "index.html"));
    panel.webview.html = `<!doctype html><body style="margin:0;background:#0e1116">
      <iframe src="${idx.toString()}?${webviewParams(relay, relay.sessionId)}" style="border:0;width:100vw;height:100vh"></iframe></body>`;
    panel.webview.onDidReceiveMessage((msg) => handleWebviewMessage(msg, {
      openFile: (p) => { void vscode.window.showTextDocument(vscode.Uri.file(p)); },
    }), undefined, context.subscriptions);
  });
  context.subscriptions.push(cmd);
}
export function deactivate(): void { /* nothing to clean up */ }
/* c8 ignore stop */
