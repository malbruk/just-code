# Edit-loss bug: root cause and fix

While dogfooding Just Code on its own repository, agent edits kept "un-happening":
string edits that reported success later vanished, the working tree drifted into
non-compiling states containing *half* of multi-file refactors that matched no
commit, and files reverted to content from before fixes that were already
committed. This document records the confirmed root cause and the fix, so the
invariants are not accidentally undone later.

## Root cause (confirmed in code, pinned by `scratch/pending-edits-test.mjs`)

`PendingEditManager` (`src/tools/diff.ts`) snapshots each file before an agent
edit and keeps the edit "pending" until accepted. Three defects combined:

1. **Nothing ever accepted the edits.** The webview showed a `pending` badge but
   rendered no Keep/Undo controls and never sent `editDecision` /
   `acceptAllEdits`. Every edit of every session stayed pending indefinitely.

2. **`newChat()` silently rejected them all.** `SessionManager.newChat()` ran
   `void this.edits.rejectAll()`. New Chat, `/clear`, `/new`, and deleting the
   on-screen conversation all funnel through `newChat()` — so starting a fresh
   chat wrote every stale pre-edit snapshot back over the working tree, including
   files whose edits had since been committed.

3. **`restore()` was a blind write, in the wrong order.** It wrote the snapshot
   without checking whether the disk still matched what the edit produced, so it
   clobbered later edits, manual changes, and committed work. `rejectAll()` also
   iterated in insertion order, so a file edited N times ended at the *last*
   edit's `before` — i.e. edits 1..N-1 kept, edit N undone: exactly the
   "half-finished refactor from no commit" symptom.

Two aggravators: a failed/denied edit left its (now stale) snapshot in the map
forever, primed to be "restored" later; and the session-side snapshot was fired
`void` (unawaited), able to race the native binary's write.

**Exonerated:** the `.claude/settings.json` PostToolUse `npx tsc --noEmit` hook.
A PostToolUse hook cannot revert files; it only slowed edits and added red-state
noise during multi-step refactors. Likewise `enableFileCheckpointing` (SDK-side
shadow checkpoints) — at the time the extension never called `rewindFiles`.
(Since issue #10 it does, but only from the explicit Rewind action, behind a
dry-run preview and a modal confirmation.)

## The fix — invariants to preserve

- **Abandoning a conversation never touches the disk.** `newChat()` now calls
  `acceptAll()`. Reverts happen only on explicit user action (Undo on a diff
  card, the `just-code.rejectAllEdits` command).
- **A revert is only legal while the disk still holds exactly what the edit
  produced.** `finalizeDiff()` records the post-edit content; `restore()`
  compares before writing and *skips with a visible warning* on any mismatch.
  Never reintroduce an unconditional write of `entry.before`.
- **`rejectAll()` unwinds newest-first**, so a multi-edited file steps back
  edit-by-edit to its true original.
- **Failed or permission-denied edits `discard()` their snapshot** the moment
  their result arrives (`session.ts` tool_result `is_error` / system
  `permission_denied`).
- **Snapshots are taken pre-execution, race-free**: `PermissionBridge.canUseTool`
  snapshots edit targets before returning `allow` (execution waits on that
  callback), and the session-side snapshot is awaited as a fallback. Both are
  idempotent per `toolUseID`.
- **Undoing a `Write` that created a file deletes the file** (tracked via
  `existedBefore`) instead of leaving an empty husk.
- The webview now renders **Keep / Undo** buttons on pending diff cards
  (`editDecision` protocol message), closing the accept loop.

## Residual caveat (not fixed here)

If a file the agent edits is open in an editor tab with unsaved manual changes,
VS Code keeps the dirty buffer; saving it later overwrites the agent's edit at
the OS level. That path is outside the extension's control — avoid keeping dirty
buffers on files the agent is working on.

Verification: `node scratch/pending-edits-test.mjs` (guarded-restore semantics),
plus the standard `npx tsc --noEmit -p tsconfig.json`, `node esbuild.js`,
`node scratch/activate-test.js`.
