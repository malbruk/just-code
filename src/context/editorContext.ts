import * as vscode from 'vscode';
import type { Attachment, EditorContext, HostToWebview } from '../shared/protocol';
import { getWorkspaceRoot } from '../agent/config';
import { relPath } from '../util/text';

/**
 * Tracks the active editor, selection, and open files, pushing a debounced
 * `editorContext` to the webview whenever they change.
 */
export class EditorContextTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly post: (msg: HostToWebview) => void) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.schedule();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidOpenTextDocument(() => this.schedule()),
      vscode.workspace.onDidCloseTextDocument(() => this.schedule()),
    );
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.post({ type: 'editorContext', context: this.current() }), 250);
  }

  /** Build the current editor context snapshot. */
  current(): EditorContext {
    const root = getWorkspaceRoot();
    const editor = vscode.window.activeTextEditor;
    const context: EditorContext = {
      openFiles: uniqueOpenFiles(root),
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
    };

    if (editor && editor.document.uri.scheme === 'file') {
      context.activeFile = relPath(root, editor.document.uri.fsPath);
      const sel = editor.selection;
      if (!sel.isEmpty) {
        context.selection = {
          path: relPath(root, editor.document.uri.fsPath),
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
          text: editor.document.getText(sel),
        };
      }
    }
    return context;
  }

  /** Build an attachment for the current selection, if any. */
  selectionAttachment(): { attachment: Attachment; text: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== 'file') return undefined;
    const root = getWorkspaceRoot();
    const path = relPath(root, editor.document.uri.fsPath);
    const sel = editor.selection;
    const text = editor.document.getText(sel);
    return {
      attachment: {
        kind: 'selection',
        path,
        label: `${path}:${sel.start.line + 1}-${sel.end.line + 1}`,
        range: { startLine: sel.start.line + 1, endLine: sel.end.line + 1 },
      },
      text,
    };
  }

  /** Build an attachment for a file URI (used by explorer context menu). */
  async fileAttachment(uri: vscode.Uri): Promise<{ attachment: Attachment; text: string } | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      const path = relPath(getWorkspaceRoot(), uri.fsPath);
      return {
        attachment: { kind: 'file', path, label: path },
        text,
      };
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}

function uniqueOpenFiles(root: string | undefined): string[] {
  const seen = new Set<string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'file' && !doc.isUntitled) {
      seen.add(relPath(root, doc.uri.fsPath));
    }
  }
  return [...seen];
}
