import * as vscode from 'vscode';
import type { DiffView } from '@just-code/core';
import { relPath } from '@just-code/core/util/text.js';
import { getWorkspaceRoot } from '../agent/config';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}

/** Count added/removed lines between two texts via an LCS line diff. */
export function countLineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deletions++;
      i++;
    } else {
      additions++;
      j++;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}

function applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (oldString === '') {
    // Insert/create semantics — new file content.
    return newString;
  }
  if (replaceAll) {
    return content.split(oldString).join(newString);
  }
  const idx = content.indexOf(oldString);
  if (idx === -1) return content;
  return content.slice(0, idx) + newString + content.slice(idx + oldString.length);
}

/**
 * Predict the resulting file content for an edit/write tool given the current
 * on-disk content. Used to build permission-preview diffs.
 */
export function predictAfter(name: string, input: Record<string, unknown>, before: string): string {
  if (name === 'Write') {
    return typeof input['content'] === 'string' ? (input['content'] as string) : before;
  }
  if (name === 'Edit') {
    const oldStr = String(input['old_string'] ?? '');
    const newStr = String(input['new_string'] ?? '');
    const replaceAll = input['replace_all'] === true;
    return applyEdit(before, oldStr, newStr, replaceAll);
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input['edits']) ? (input['edits'] as Record<string, unknown>[]) : [];
    let content = before;
    for (const e of edits) {
      content = applyEdit(content, String(e['old_string'] ?? ''), String(e['new_string'] ?? ''), e['replace_all'] === true);
    }
    return content;
  }
  return before;
}

/** The absolute file path an edit/write tool targets, if any. */
export function editToolPath(input: Record<string, unknown>): string | undefined {
  const p = input['file_path'] ?? input['path'] ?? input['notebook_path'];
  return typeof p === 'string' ? p : undefined;
}

async function readFileIfExists(fsPath: string): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return '';
  }
}

/** Build a preview DiffView (before = disk now, after = predicted) for permission UI. */
export async function buildPreviewDiff(name: string, input: Record<string, unknown>): Promise<DiffView | undefined> {
  const fsPath = editToolPath(input);
  if (!fsPath) return undefined;
  const before = await readFileIfExists(fsPath);
  const after = predictAfter(name, input, before);
  const { additions, deletions } = countLineDiff(before, after);
  return { path: relPath(getWorkspaceRoot(), fsPath), before, after, additions, deletions };
}

interface PendingEdit {
  toolUseId: string;
  fsPath: string;
  /** Content before the tool touched the file. */
  before: string;
}

/**
 * Tracks edits that have been written to disk by the agent but not yet
 * accepted by the user. "Reject" restores the pre-edit snapshot; "accept"
 * simply forgets it. Also owns the `just-code.hasPendingEdits` context key
 * and a virtual-document provider so we can open native diff editors.
 */
export class PendingEditManager implements vscode.Disposable {
  static readonly SCHEME = 'just-code-diff';
  private readonly pending = new Map<string, PendingEdit>();
  private readonly snapshotContent = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const provider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri) => this.snapshotContent.get(uri.toString()) ?? '',
    };
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PendingEditManager.SCHEME, provider),
    );
  }

  /** Snapshot the current on-disk content before an edit executes. */
  async snapshot(toolUseId: string, fsPath: string): Promise<void> {
    if (this.pending.has(toolUseId)) return;
    const before = await readFileIfExists(fsPath);
    this.pending.set(toolUseId, { toolUseId, fsPath, before });
    this.updateContextKey();
  }

  /**
   * After a successful edit tool_result, compute the applied DiffView from the
   * snapshot and the new on-disk content.
   */
  async finalizeDiff(toolUseId: string): Promise<DiffView | undefined> {
    const entry = this.pending.get(toolUseId);
    if (!entry) return undefined;
    const after = await readFileIfExists(entry.fsPath);
    const { additions, deletions } = countLineDiff(entry.before, after);
    return {
      path: relPath(getWorkspaceRoot(), entry.fsPath),
      before: entry.before,
      after,
      additions,
      deletions,
      pending: true,
    };
  }

  has(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }

  hasAny(): boolean {
    return this.pending.size > 0;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Accept a single pending edit — just drop the snapshot. */
  accept(toolUseId: string): void {
    this.pending.delete(toolUseId);
    this.updateContextKey();
  }

  acceptAll(): void {
    this.pending.clear();
    this.updateContextKey();
  }

  /** Reject a single pending edit — restore the pre-edit content to disk. */
  async reject(toolUseId: string): Promise<void> {
    const entry = this.pending.get(toolUseId);
    if (!entry) return;
    await this.restore(entry);
    this.pending.delete(toolUseId);
    this.updateContextKey();
  }

  async rejectAll(): Promise<void> {
    for (const entry of this.pending.values()) {
      await this.restore(entry);
    }
    this.pending.clear();
    this.updateContextKey();
  }

  private async restore(entry: PendingEdit): Promise<void> {
    const uri = vscode.Uri.file(entry.fsPath);
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(entry.before, 'utf8'));
    } catch {
      // File may have been deleted; ignore.
    }
  }

  /** Open the native diff editor for a pending edit (before snapshot vs current). */
  async openDiff(toolUseId: string): Promise<void> {
    const entry = this.pending.get(toolUseId);
    if (!entry) return;
    const key = `${PendingEditManager.SCHEME}:${toolUseId}`;
    const leftUri = vscode.Uri.parse(`${PendingEditManager.SCHEME}:/${encodeURIComponent(toolUseId)}/before`);
    this.snapshotContent.set(leftUri.toString(), entry.before);
    const rightUri = vscode.Uri.file(entry.fsPath);
    const title = `${relPath(getWorkspaceRoot(), entry.fsPath)} (Claude edit)`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    void key;
  }

  private updateContextKey(): void {
    void vscode.commands.executeCommand('setContext', 'just-code.hasPendingEdits', this.pending.size > 0);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.pending.clear();
    this.snapshotContent.clear();
    this.updateContextKey();
  }
}
