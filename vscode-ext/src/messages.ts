export interface MessageDeps { openFile: (path: string) => void; }
/** Route a webview→host message. Only `open-file` is honored (REQ-052). */
export function handleWebviewMessage(msg: unknown, deps: MessageDeps): void {
  if (typeof msg !== "object" || msg === null) return;
  const m = msg as Record<string, unknown>;
  if (m.type === "open-file" && typeof m.path === "string") deps.openFile(m.path);
}
