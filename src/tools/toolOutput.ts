/**
 * Read-only editor tabs for a tool's full output.
 *
 * The transcript only shows a tool's first few output lines; the rest opens in
 * the editor area as a virtual document — the same place a file would open, not
 * a scrolling box inside the chat.
 *
 * The text is served by a `TextDocumentContentProvider` on a custom scheme,
 * which VS Code treats as read-only for free. One URI per tool-use id, so
 * re-opening the same step reuses its tab rather than stacking duplicates.
 */
import * as vscode from 'vscode';

const SCHEME = 'just-code-output';

/** `toolu_01AbC…` → `01abc…`; the tab title needs a short, stable disambiguator. */
function shortId(toolUseId: string): string {
  const tail = toolUseId.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase();
  return tail || 'output';
}

const contents = new Map<string, string>();
const onDidChange = new vscode.EventEmitter<vscode.Uri>();

const provider: vscode.TextDocumentContentProvider = {
  onDidChange: onDidChange.event,
  provideTextDocumentContent: (uri) => contents.get(uri.path) ?? '',
};

export function registerToolOutputDocuments(): vscode.Disposable {
  const reg = vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
  return {
    dispose(): void {
      reg.dispose();
      onDidChange.dispose();
      contents.clear();
    },
  };
}

/** Open (or refresh) the tab holding `text`, titled like `Bash tool output (a1b2c3)`. */
export async function showToolOutput(
  toolName: string,
  toolUseId: string,
  text: string,
): Promise<void> {
  const uri = vscode.Uri.from({
    scheme: SCHEME,
    path: `/${toolName} tool output (${shortId(toolUseId)})`,
  });
  contents.set(uri.path, text);
  onDidChange.fire(uri);

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'plaintext');
  await vscode.window.showTextDocument(doc, {
    preview: true,
    viewColumn: vscode.ViewColumn.Active,
  });
}
