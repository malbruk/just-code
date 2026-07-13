/**
 * Pure helpers for the edit/write tool family. No `vscode`, no I/O — just
 * string math over tool inputs and file contents. Lives in core so both the
 * VS Code diff manager and the IntelliJ sidecar can reason about edits the same
 * way (which tools edit, the file they target, the predicted result, line counts).
 */

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Whether a tool name is one that mutates a file on disk. */
export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}

/** The absolute file path an edit/write tool targets, if any. */
export function editToolPath(input: Record<string, unknown>): string | undefined {
  const p = input['file_path'] ?? input['path'] ?? input['notebook_path'];
  return typeof p === 'string' ? p : undefined;
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
 * on-disk content. Used to build permission-preview and applied diffs.
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
