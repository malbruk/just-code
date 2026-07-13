/**
 * In-memory application state for the webview, plus the reducers that fold
 * incoming host messages into it. Keeping mutations here makes `main.ts` a thin
 * message router and keeps rendering a pure function of this state.
 */
import type {
  Attachment,
  AuthMethod,
  AuthStage,
  ChatMessage,
  ContentBlock,
  EditorContext,
  EffortLevel,
  ModelId,
  PermissionMode,
  PermissionRequest,
  RateLimitWarning,
  SlashCommand,
  ToolUseView,
  UsageInfo,
  WebviewState,
} from '../../src/shared/protocol.js';

export interface AppState {
  messages: ChatMessage[];
  model: ModelId;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  extendedThinking: boolean;
  autoModelFallback: boolean;
  busy: boolean;
  editorContext: EditorContext;
  usage?: UsageInfo;
  /** Plan-limit banner shown above the composer, when a window is nearly spent. */
  rateLimitWarning?: RateLimitWarning;
  signedIn: boolean;
  /** In-panel sign-in flow stage (only meaningful when signed out). */
  authStage: AuthStage;
  authMethod?: AuthMethod;
  authUrl?: string;
  authMessage?: string;
  slashCommands: SlashCommand[];
  /** Short generated title for the conversation; absent until the first turn ends. */
  sessionTitle?: string;
  /** Outstanding permission prompts, newest last. */
  pendingPermissions: PermissionRequest[];
  /** Combined list shown as chips: the ephemeral editor-context chip + pinned. */
  attachments: Attachment[];
  /** Explicitly added, sticky attachments (add-to-chat commands, pasted images, uploads). */
  pinned: Attachment[];
  /** Labels the user explicitly removed, so refreshed editor context won't re-add them. */
  removedAttachmentLabels: Set<string>;
  /** Whether we've received the first `init`. */
  initialized: boolean;
}

export function createInitialState(): AppState {
  return {
    messages: [],
    model: 'default',
    permissionMode: 'default',
    effort: 'default',
    extendedThinking: true,
    autoModelFallback: false,
    busy: false,
    editorContext: { openFiles: [] },
    usage: undefined,
    signedIn: true,
    authStage: 'choose',
    slashCommands: [],
    pendingPermissions: [],
    attachments: [],
    pinned: [],
    removedAttachmentLabels: new Set(),
    initialized: false,
  };
}

export function applyInit(state: AppState, ws: WebviewState): void {
  state.messages = Array.isArray(ws.messages) ? ws.messages.slice() : [];
  state.model = ws.model ?? 'default';
  state.permissionMode = ws.permissionMode ?? 'default';
  state.effort = ws.effort ?? 'default';
  state.extendedThinking = ws.extendedThinking !== false;
  state.autoModelFallback = Boolean(ws.autoModelFallback);
  state.busy = Boolean(ws.busy);
  state.editorContext = ws.editorContext ?? { openFiles: [] };
  state.usage = ws.usage;
  state.rateLimitWarning = ws.rateLimitWarning;
  state.signedIn = ws.signedIn !== false;
  state.authMethod = ws.auth?.method;
  state.slashCommands = Array.isArray(ws.slashCommands) ? ws.slashCommands : [];
  state.sessionTitle = ws.sessionTitle;
  state.pendingPermissions = [];
  state.initialized = true;
  recomputeContextAttachments(state);
}

export function getMessage(state: AppState, id: string): ChatMessage | undefined {
  return state.messages.find((m) => m.id === id);
}

export function upsertUserMessage(state: AppState, message: ChatMessage): void {
  const existing = getMessage(state, message.id);
  if (existing) Object.assign(existing, message);
  else state.messages.push(message);
}

/** Append a message (system notice / command echo) to the transcript. */
export function appendMessage(state: AppState, message: ChatMessage): void {
  if (!getMessage(state, message.id)) state.messages.push(message);
}

export function ensureAssistantMessage(state: AppState, id: string): ChatMessage {
  let msg = getMessage(state, id);
  if (!msg) {
    msg = { id, role: 'assistant', blocks: [], streaming: true, createdAt: Date.now() };
    state.messages.push(msg);
  } else {
    msg.streaming = true;
  }
  return msg;
}

/** Close the trailing thinking block (record how long it ran), if still open. */
function closeThinking(msg: ChatMessage): void {
  const last = msg.blocks[msg.blocks.length - 1];
  if (last && last.type === 'thinking' && last.endedAt == null) last.endedAt = Date.now();
}

/** Append a streaming delta to the last matching block, or start a new one. */
export function applyStreamDelta(
  state: AppState,
  id: string,
  blockType: 'text' | 'thinking',
  delta: string,
): void {
  const msg = ensureAssistantMessage(state, id);
  const last = msg.blocks[msg.blocks.length - 1];
  if (last && last.type === blockType) {
    last.text += delta;
  } else {
    // Any content after a thinking block means the model stopped thinking.
    if (blockType !== 'thinking') closeThinking(msg);
    const block: ContentBlock =
      blockType === 'thinking'
        ? { type: 'thinking', text: delta, startedAt: Date.now() }
        : { type: 'text', text: delta };
    msg.blocks.push(block);
  }
}

export function applyToolUpdate(state: AppState, id: string, tool: ToolUseView): void {
  const msg = ensureAssistantMessage(state, id);
  for (const block of msg.blocks) {
    if (block.type === 'tool_use' && block.toolUse.id === tool.id) {
      block.toolUse = tool;
      return;
    }
  }
  closeThinking(msg);
  msg.blocks.push({ type: 'tool_use', toolUse: tool });
}

export function markDone(state: AppState, id: string): void {
  const msg = getMessage(state, id);
  if (msg) {
    closeThinking(msg);
    msg.streaming = false;
  }
}

export function appendError(state: AppState, message: string, messageId?: string): void {
  if (messageId) {
    const msg = getMessage(state, messageId);
    if (msg) {
      msg.streaming = false;
      msg.blocks.push({ type: 'error', text: message });
      return;
    }
  }
  state.messages.push({
    id: `err-${Date.now()}`,
    role: 'system',
    blocks: [{ type: 'error', text: message }],
    createdAt: Date.now(),
  });
}

export function addPermission(state: AppState, req: PermissionRequest): void {
  if (!state.pendingPermissions.some((p) => p.id === req.id)) {
    state.pendingPermissions.push(req);
  }
}

export function resolvePermission(state: AppState, id: string): void {
  state.pendingPermissions = state.pendingPermissions.filter((p) => p.id !== id);
}

/**
 * Rebuild the displayed chip list: an *ephemeral* chip for the current editor
 * context (active file, or selection if any) followed by the *pinned* explicit
 * attachments. Pinned attachments survive editor changes; the ephemeral one
 * tracks the active editor and is suppressed if the user removed it or if it
 * duplicates a pinned entry.
 */
export function recomputeContextAttachments(state: AppState): void {
  const ctx = state.editorContext;
  const next: Attachment[] = [];

  let ephemeral: Attachment | undefined;
  if (ctx.selection) {
    const { path, startLine, endLine } = ctx.selection;
    const label = `${basename(path)}:${startLine}-${endLine}`;
    if (!state.removedAttachmentLabels.has(label)) {
      ephemeral = { kind: 'selection', path, label, range: { startLine, endLine } };
    }
  } else if (ctx.activeFile) {
    const label = basename(ctx.activeFile);
    if (!state.removedAttachmentLabels.has(label)) {
      ephemeral = { kind: 'file', path: ctx.activeFile, label };
    }
  }
  if (ephemeral && !state.pinned.some((p) => p.label === ephemeral!.label)) {
    ephemeral.ephemeral = true;
    next.push(ephemeral);
  }

  for (const p of state.pinned) next.push(p);
  state.attachments = next;
}

export function removeAttachment(state: AppState, index: number): void {
  const a = state.attachments[index];
  if (!a) return;
  const pinnedIdx = state.pinned.findIndex((p) => p.label === a.label);
  if (pinnedIdx >= 0) {
    state.pinned.splice(pinnedIdx, 1);
  } else {
    // Ephemeral editor-context chip: remember the removal so it doesn't re-add.
    state.removedAttachmentLabels.add(a.label);
  }
  recomputeContextAttachments(state);
}

/**
 * Drop every pinned attachment — called once a turn is sent, since the files
 * and images belong to that prompt and must not silently ride along on the
 * next one. The ephemeral active-editor chip is deliberately left alone: it
 * tracks the editor rather than the prompt, so it is rebuilt by the recompute
 * below and stays put, exactly as it does between turns.
 */
export function clearAttachments(state: AppState): void {
  state.pinned = [];
  recomputeContextAttachments(state);
}

/** Explicitly pin an attachment into the composer (dedup by label). */
export function addAttachment(state: AppState, attachment: Attachment): void {
  state.removedAttachmentLabels.delete(attachment.label);
  if (!state.pinned.some((a) => a.label === attachment.label)) {
    state.pinned.push(attachment);
  }
  recomputeContextAttachments(state);
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
