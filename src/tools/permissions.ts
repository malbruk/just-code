import type { CanUseTool, PermissionResult, PermissionUpdate } from '../agent/sdk';
import type {
  HostToWebview,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  QuestionOption,
  QuestionSpec,
} from '../shared/protocol';
import { toolTitle } from '../util/text';
import { buildPreviewDiff, isEditTool } from './diff';
import { getWorkspaceRoot } from '../agent/config';
import type { Logger } from '../util/logger';

/**
 * The built-in tool that asks the user to choose between options. It arrives
 * through `canUseTool` like a permission prompt, but it is a *question*, not an
 * authorization: the UI renders a choice card and the selection is handed back
 * to the tool via `updatedInput.answers`.
 */
const ASK_USER_QUESTION = 'AskUserQuestion';

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

    // A question is never auto-answerable: no permission mode may skip it, and
    // plan mode in particular must not deny it — asking the user to choose is
    // the whole point of planning.
    const questions = toolName === ASK_USER_QUESTION ? parseQuestions(input) : undefined;
    if (questions?.length) {
      return this.askQuestions(input, questions, options.signal);
    }

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

  /**
   * Render a choice card and wait for the user to pick. The answers ride back
   * on `updatedInput` — the tool reads them from there and echoes them as its
   * result, which is how the model learns what was chosen.
   */
  private async askQuestions(
    input: Record<string, unknown>,
    questions: QuestionSpec[],
    signal: AbortSignal | undefined,
  ): Promise<PermissionResult> {
    const id = `ask-${++this.seq}`;
    const request: PermissionRequest = {
      id,
      toolName: ASK_USER_QUESTION,
      input,
      title: questions[0]!.question,
      questions,
    };

    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.pending.set(id, { resolve });
      this.post({ type: 'permissionRequest', request });
      if (signal) {
        signal.addEventListener('abort', () => this.resolve(id, { behavior: 'deny', message: 'Aborted' }), {
          once: true,
        });
      }
    });

    if (decision.behavior === 'deny' || !decision.answers) {
      return {
        behavior: 'deny',
        message: decision.behavior === 'deny' ? (decision.message ?? 'User dismissed the question.') : 'No answer given.',
      };
    }

    return {
      behavior: 'allow',
      updatedInput: { ...input, answers: decision.answers, annotations: annotate(questions, decision.answers) },
    };
  }
}

/**
 * Echo back the preview text of whichever option was chosen, per the tool's
 * `annotations` schema. Questions without previews contribute nothing.
 */
function annotate(
  questions: QuestionSpec[],
  answers: Record<string, string>,
): Record<string, { preview?: string }> | undefined {
  const out: Record<string, { preview?: string }> = {};
  for (const q of questions) {
    const chosen = answers[q.question];
    const preview = q.options.find((o) => o.label === chosen)?.preview;
    if (preview) out[q.question] = { preview };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate the `questions` array out of the raw tool input. Anything malformed
 * yields `undefined`, which sends the call down the ordinary allow/deny path
 * rather than rendering a card with no options to click.
 */
function parseQuestions(input: Record<string, unknown>): QuestionSpec[] | undefined {
  const raw = input['questions'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const questions: QuestionSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined;
    const q = item as Record<string, unknown>;
    const question = typeof q['question'] === 'string' ? q['question'] : undefined;
    const header = typeof q['header'] === 'string' ? q['header'] : undefined;
    if (!question || !Array.isArray(q['options'])) return undefined;

    const options: QuestionOption[] = [];
    for (const opt of q['options']) {
      if (!opt || typeof opt !== 'object') return undefined;
      const o = opt as Record<string, unknown>;
      if (typeof o['label'] !== 'string' || !o['label']) return undefined;
      options.push({
        label: o['label'],
        description: typeof o['description'] === 'string' ? o['description'] : '',
        preview: typeof o['preview'] === 'string' ? o['preview'] : undefined,
      });
    }
    if (options.length === 0) return undefined;

    questions.push({ question, header: header ?? '', multiSelect: q['multiSelect'] === true, options });
  }
  return questions;
}

async function safeBuildDiff(name: string, input: Record<string, unknown>, log: Logger) {
  try {
    return await buildPreviewDiff(name, input);
  } catch (err) {
    log.warn('Failed to build preview diff', err);
    return undefined;
  }
}
