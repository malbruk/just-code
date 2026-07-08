import type { CanUseTool, PermissionResult, PermissionUpdate } from '../agent/sdk';
import type { HostToWebview, PermissionDecision, PermissionMode, PermissionRequest } from '../shared/protocol';
import { toolTitle } from '../util/text';
import { buildPreviewDiff, isEditTool } from './diff';
import { getWorkspaceRoot } from '../agent/config';
import type { Logger } from '../util/logger';

/** Tools that never mutate state — safe to auto-allow. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'BashOutput',
  'Task',
]);

interface Pending {
  resolve: (decision: PermissionDecision) => void;
}

/**
 * Bridges the SDK `canUseTool` callback to the webview. Emits a
 * `permissionRequest` and awaits the user's `permissionDecision`. Short-circuits
 * based on the active permission mode and tool category.
 */
export class PermissionBridge {
  private mode: PermissionMode = 'default';
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private readonly post: (msg: HostToWebview) => void,
    private readonly log: Logger,
  ) {}

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Resolve an outstanding request from a webview decision. */
  resolve(id: string, decision: PermissionDecision): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.post({ type: 'permissionResolved', id });
    entry.resolve(decision);
  }

  /** Reject all outstanding prompts (e.g. on interrupt / new chat). */
  cancelAll(message = 'Cancelled'): void {
    for (const [id, entry] of this.pending) {
      this.post({ type: 'permissionResolved', id });
      entry.resolve({ behavior: 'deny', message });
    }
    this.pending.clear();
  }

  /** The `canUseTool` implementation passed to the SDK. */
  readonly canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    const suggestions = options.suggestions;

    // Mode short-circuits.
    if (this.mode === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: input };
    }
    if (this.mode === 'plan') {
      if (READ_ONLY_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: 'Plan mode is read-only; this action was not performed.' };
    }
    // Auto-allow read-only tools in every interactive mode.
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    // acceptEdits auto-approves file mutations, still prompts for others.
    if (this.mode === 'acceptEdits' && isEditTool(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    // Otherwise, ask the user.
    const id = `perm-${++this.seq}`;
    const title = options.title ?? toolTitle(toolName, input, getWorkspaceRoot());
    const diff = isEditTool(toolName) ? await safeBuildDiff(toolName, input, this.log) : undefined;

    const request: PermissionRequest = {
      id,
      toolName,
      input,
      title,
      diff,
      canRemember: !!suggestions && suggestions.length > 0,
    };

    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.pending.set(id, { resolve });
      this.post({ type: 'permissionRequest', request });

      // Honor an SDK-side abort.
      if (options.signal) {
        options.signal.addEventListener(
          'abort',
          () => this.resolve(id, { behavior: 'deny', message: 'Aborted' }),
          { once: true },
        );
      }
    });

    if (decision.behavior === 'deny') {
      return { behavior: 'deny', message: decision.message ?? 'Denied by user.' };
    }

    const result: PermissionResult = { behavior: 'allow', updatedInput: input };
    if (decision.remember && suggestions && suggestions.length > 0) {
      result.updatedPermissions = suggestions as PermissionUpdate[];
    }
    return result;
  };
}

async function safeBuildDiff(name: string, input: Record<string, unknown>, log: Logger) {
  try {
    return await buildPreviewDiff(name, input);
  } catch (err) {
    log.warn('Failed to build preview diff', err);
    return undefined;
  }
}
