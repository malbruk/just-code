import { loadSdk } from '@just-code/core/agent/sdk.js';
import type {
  McpServerStatus,
  Options,
  Query,
  SDKControlGetUsageResponse,
  SDKMessage,
  SDKRateLimitInfo,
  SDKUserMessage,
} from '@just-code/core/agent/sdk.js';
import type {
  ChatMessage,
  ContentBlock,
  HostToWebview,
  ToolUseView,
  UsageInfo,
} from '@just-code/core';
import type { PermissionMode, ModelId } from '@just-code/core';
import { AsyncQueue } from '@just-code/core/agent/asyncQueue.js';
import { PendingEditManager, isEditTool, editToolPath } from '../tools/diff';
import { resultToText, toolTitle, truncate } from '@just-code/core/util/text.js';
import { classifyStreamError } from '@just-code/core/agent/errors.js';
import type { ClassifiedError } from '@just-code/core/agent/errors.js';
import type { Logger } from '../util/logger';

let msgCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(msgCounter++).toString(36)}`;
}

/** The four image media types the Messages API accepts. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** A decoded image attachment, ready to become an `image` content block. */
export interface ImageInput {
  mediaType: ImageMediaType;
  /** Base64 payload, without the `data:` URI prefix. */
  data: string;
}

/** The prompt as the SDK wants it: a bare string, or ordered content blocks. */
function buildContent(promptText: string, images: ImageInput[]): SDKUserMessage['message']['content'] {
  if (!images.length) return promptText;
  const blocks: Exclude<SDKUserMessage['message']['content'], string> = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
  if (promptText.trim()) blocks.push({ type: 'text', text: promptText });
  return blocks;
}

export interface SessionDeps {
  post: (msg: HostToWebview) => void;
  options: Options;
  abortController: AbortController;
  edits: PendingEditManager;
  log: Logger;
  root?: string;
  initialMessages?: ChatMessage[];
  onSessionId?: (id: string) => void;
  onUsage?: (usage: UsageInfo) => void;
  /** The runtime reported a change in claude.ai plan rate-limit state. */
  onRateLimit?: (info: SDKRateLimitInfo) => void;
  /** A turn finished (the SDK sent its `result`). */
  onTurnComplete?: (sessionId: string | undefined) => void;
  /**
   * The session died. The handler owns reporting it to the user (transcript +
   * any notification). When absent, the bare summary is posted instead.
   */
  onError?: (error: ClassifiedError) => void;
}

/**
 * Owns a single long-lived `query()` in streaming-input mode. User turns are
 * pushed into an {@link AsyncQueue}; the SDK's `SDKMessage` stream is translated
 * into `HostToWebview` protocol messages and mirrored into `messages`.
 */
export class AgentSession {
  readonly messages: ChatMessage[] = [];
  sessionId: string | undefined;
  private busy = false;

  private readonly queue = new AsyncQueue<SDKUserMessage>();
  private query: Query | undefined;
  private started = false;

  // `start()` is synchronous but the SDK loads (and the query is created)
  // asynchronously. Control requests issued before a turn is ever submitted —
  // the Account & usage dialog does exactly that — must wait for the query
  // rather than silently no-op. Resolves with undefined if startup failed.
  private resolveQuery!: (q: Query | undefined) => void;
  private readonly queryReady = new Promise<Query | undefined>((resolve) => (this.resolveQuery = resolve));

  private activeMessageId: string | undefined;
  private activeMessage: ChatMessage | undefined;
  private readonly blockTypeByIndex = new Map<number, string>();
  private readonly toolViews = new Map<string, { messageId: string; view: ToolUseView }>();

  // Real context-window occupancy from the most recent single API call. The
  // aggregated `result.usage` sums cache reads across every tool round-trip in a
  // turn, so it wildly overstates how full the window actually is — a per-call
  // value (input + cache_read + cache_creation) is the true prompt size.
  private lastContextTokens: number | undefined;
  // Model id of that same call, so we divide by *its* context window (e.g. a
  // Haiku subagent is 200k while the main Opus model may be 1M).
  private lastModel: string | undefined;

  constructor(private readonly deps: SessionDeps) {
    if (deps.initialMessages) {
      this.messages.push(...deps.initialMessages);
    }
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Start consuming the SDK stream. Safe to call once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const { query } = await loadSdk();
      this.query = query({ prompt: this.queue, options: this.deps.options });
      this.resolveQuery(this.query);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.error('Failed to start agent query', err);
      this.deps.post({ type: 'error', message });
      this.resolveQuery(undefined);
      this.setBusy(false);
      return;
    }
    await this.consume();
  }

  /**
   * The live `Query`, starting the session if it hasn't been started yet.
   * Undefined when startup failed.
   */
  private async ready(): Promise<Query | undefined> {
    if (!this.started) this.start();
    return this.queryReady;
  }

  /**
   * Add a user turn to the transcript and enqueue it for the agent.
   *
   * With no images the prompt goes over as a plain string. Images force the
   * structured form: blocks first, then the text — the ordering Anthropic
   * recommends, and the text block is omitted entirely when the user sent a
   * bare screenshot (the API rejects an empty one).
   */
  submit(message: ChatMessage, promptText: string, images: ImageInput[] = []): void {
    if (!this.started) this.start();
    this.messages.push(message);
    this.deps.post({ type: 'userMessage', message });
    this.setBusy(true);
    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: buildContent(promptText, images) },
      parent_tool_use_id: null,
    };
    this.queue.push(userMsg);
  }

  async interrupt(): Promise<void> {
    try {
      await this.query?.interrupt();
    } catch (err) {
      this.deps.log.warn('interrupt failed', err);
    } finally {
      this.finishActiveMessage();
      this.setBusy(false);
    }
  }

  async setModel(model: ModelId): Promise<void> {
    if (!this.query) return;
    try {
      await this.query.setModel(model === 'default' ? undefined : model);
    } catch (err) {
      this.deps.log.warn('setModel failed', err);
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.query) return;
    try {
      await this.query.setPermissionMode(mode);
    } catch (err) {
      this.deps.log.warn('setPermissionMode failed', err);
    }
  }

  /**
   * Toggle extended thinking live. `null` clears the limit (restores the model
   * default / adaptive thinking); `0` disables thinking entirely.
   */
  async setThinking(enabled: boolean): Promise<void> {
    if (!this.query) return;
    try {
      await this.query.setMaxThinkingTokens(enabled ? null : 0);
    } catch (err) {
      this.deps.log.warn('setThinking failed', err);
    }
  }

  /**
   * Live status of every MCP server the runtime loaded, or undefined when no
   * `query()` is running yet (the servers connect during session startup).
   */
  async mcpServerStatus(): Promise<McpServerStatus[] | undefined> {
    if (!this.query) return undefined;
    try {
      return await this.query.mcpServerStatus();
    } catch (err) {
      this.deps.log.warn('mcpServerStatus failed', err);
      return undefined;
    }
  }

  /**
   * The structured data behind `/usage`: session cost plus claude.ai plan
   * rate-limit utilization. Starts the runtime if it isn't running yet — the
   * control request works on a query that has never been sent a prompt.
   *
   * The SDK marks this API experimental and may rename it; a failure here is
   * reported as "unavailable" rather than breaking the dialog.
   */
  async getUsage(): Promise<SDKControlGetUsageResponse | undefined> {
    const q = await this.ready();
    if (!q) return undefined;
    try {
      return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    } catch (err) {
      this.deps.log.warn('usage request failed', err);
      return undefined;
    }
  }

  dispose(): void {
    try {
      this.queue.end();
      this.deps.abortController.abort();
      // Unblock anything awaiting a query that will now never arrive.
      this.resolveQuery(this.query);
    } catch {
      /* ignore */
    }
  }

  // --- internals -----------------------------------------------------------

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.deps.post({ type: 'status', busy });
  }

  /**
   * Report a fatal session error: close any streaming message, log the raw text,
   * and hand a classified error to the owner (which surfaces it to the user).
   */
  private fail(raw: string): void {
    const error = classifyStreamError(raw);
    this.deps.log.error(`Session stream error [${error.kind}]: ${raw}`);
    this.finishActiveMessage();
    if (this.deps.onError) this.deps.onError(error);
    else this.deps.post({ type: 'error', message: error.message });
    this.setBusy(false);
  }

  private async consume(): Promise<void> {
    try {
      for await (const msg of this.query!) {
        try {
          await this.handleMessage(msg);
        } catch (err) {
          this.deps.log.error('Error handling SDK message', err);
        }
      }
    } catch (err) {
      // An intentional teardown (dispose → abort, e.g. New Chat or switching to
      // a history session) surfaces here as "Operation aborted". That's not a
      // real error — stay silent so it never lands in the transcript.
      if (this.deps.abortController.signal.aborted) {
        this.setBusy(false);
        return;
      }
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }

    // The iterator finished without throwing. If a turn was still in flight the
    // runtime went away without sending a `result` and without erroring — leave
    // it unhandled and the composer spins forever with nothing to explain it.
    if (this.busy && !this.deps.abortController.signal.aborted) {
      this.fail('The Claude Code runtime closed its output stream mid-turn.');
      return;
    }
    this.setBusy(false);
  }

  private async handleMessage(msg: SDKMessage): Promise<void> {
    switch (msg.type) {
      case 'system':
        this.handleSystem(msg);
        return;
      case 'rate_limit_event':
        this.deps.onRateLimit?.(msg.rate_limit_info);
        return;
      case 'stream_event':
        this.handleStreamEvent(msg);
        return;
      case 'assistant':
        await this.handleAssistant(msg);
        return;
      case 'user':
        await this.handleUser(msg);
        return;
      case 'result':
        this.handleResult(msg);
        return;
      default:
        // Many informational message types exist; ignore gracefully.
        return;
    }
  }

  private handleSystem(msg: Extract<SDKMessage, { type: 'system' }>): void {
    if (msg.subtype === 'init') {
      if (msg.session_id && !this.sessionId) {
        this.sessionId = msg.session_id;
        this.deps.onSessionId?.(msg.session_id);
      }
    } else if (msg.subtype === 'permission_denied') {
      const denied = msg as unknown as { tool_use_id?: string; tool_name?: string };
      if (denied.tool_use_id) {
        this.markToolStatus(denied.tool_use_id, 'denied', 'Permission denied');
        // A denied edit never ran; its snapshot must not linger (see handleUser).
        this.deps.edits.discard(denied.tool_use_id);
      }
    }
  }

  private handleStreamEvent(msg: Extract<SDKMessage, { type: 'stream_event' }>): void {
    const event = msg.event as {
      type: string;
      index?: number;
      content_block?: { type?: string };
      delta?: { type?: string; text?: string; thinking?: string };
    };

    switch (event.type) {
      case 'message_start':
        this.beginAssistantMessage();
        break;
      case 'content_block_start':
        if (event.index !== undefined && event.content_block?.type) {
          this.blockTypeByIndex.set(event.index, event.content_block.type);
        }
        break;
      case 'content_block_delta': {
        const d = event.delta;
        if (!d) break;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          this.appendDelta('text', d.text);
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          this.appendDelta('thinking', d.thinking);
        }
        break;
      }
      default:
        break;
    }
  }

  private beginAssistantMessage(): void {
    // Finalize any previous open assistant message first.
    this.finishActiveMessage();
    const id = nextId('a');
    this.activeMessageId = id;
    this.activeMessage = { id, role: 'assistant', blocks: [], streaming: true, createdAt: Date.now() };
    this.messages.push(this.activeMessage);
    this.blockTypeByIndex.clear();
    this.deps.post({ type: 'assistantStart', messageId: id });
  }

  private ensureActiveMessage(): ChatMessage {
    if (!this.activeMessage) this.beginAssistantMessage();
    return this.activeMessage!;
  }

  private appendDelta(blockType: 'text' | 'thinking', delta: string): void {
    const message = this.ensureActiveMessage();
    const last = message.blocks[message.blocks.length - 1];
    if (last && last.type === blockType) {
      last.text += delta;
    } else {
      message.blocks.push({ type: blockType, text: delta } as ContentBlock);
    }
    this.deps.post({ type: 'streamDelta', messageId: message.id, blockType, delta });
  }

  private async handleAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): Promise<void> {
    const message = this.ensureActiveMessage();
    const beta = msg.message as unknown as {
      content?: Array<Record<string, unknown>>;
      usage?: Record<string, number>;
      model?: string;
    };
    const content = Array.isArray(beta.content) ? beta.content : [];

    // Per-call prompt size = true context-window occupancy at this point in the turn.
    const cu = beta.usage;
    if (cu) {
      const ctx =
        (cu['input_tokens'] ?? 0) +
        (cu['cache_read_input_tokens'] ?? 0) +
        (cu['cache_creation_input_tokens'] ?? 0);
      if (ctx > 0) {
        this.lastContextTokens = ctx;
        if (beta.model) this.lastModel = beta.model;
      }
    }

    // Text normally arrives as `stream_event` deltas (includePartialMessages),
    // so we do not render it again here. But a *synthetic* assistant message —
    // the CLI fabricates one when the API call itself fails (rate limit, 5xx, a
    // captive-portal/proxy interception) — never streams. Its text block is the
    // only place the failure is reported. Dropping it means the user sees the
    // turn end with no output and no error at all.
    const streamedText = message.blocks.some((b) => b.type === 'text' && b.text.length > 0);
    if (!streamedText) {
      for (const block of content) {
        if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].length > 0) {
          const text = block['text'];
          // A synthetic turn is always a failure report. Mirror it to the output
          // channel too — the chat bubble may be a wall of proxy HTML, and the
          // log is where a user goes to find out what actually happened.
          this.deps.log.error(`API error (synthetic turn): ${text.slice(0, 500)}`);
          this.appendDelta('text', text);
        }
      }
    }

    for (const block of content) {
      if (block['type'] === 'tool_use') {
        const id = String(block['id'] ?? nextId('tool'));
        const name = String(block['name'] ?? 'Tool');
        const input = (block['input'] as Record<string, unknown>) ?? {};
        const view: ToolUseView = {
          id,
          name,
          input,
          status: 'running',
          title: toolTitle(name, input, this.deps.root),
          requiresPermission: isEditTool(name) || !isReadOnly(name),
        };
        this.toolViews.set(id, { messageId: message.id, view });
        message.blocks.push({ type: 'tool_use', toolUse: view });

        // Snapshot pre-edit content so we can build the applied diff & allow
        // revert. Awaited: an unordered (`void`) read can race the native
        // binary's write and capture post-edit content as "before". The
        // permission bridge also snapshots pre-approval; this is idempotent.
        if (isEditTool(name)) {
          const fsPath = editToolPath(input);
          if (fsPath) await this.deps.edits.snapshot(id, fsPath);
        }
        this.deps.post({ type: 'toolUpdate', messageId: message.id, tool: view });
      }
    }
  }

  private async handleUser(msg: Extract<SDKMessage, { type: 'user' }>): Promise<void> {
    const param = msg.message as unknown as { content?: unknown };
    const content = param.content;
    if (!Array.isArray(content)) return;

    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] !== 'tool_result') continue;
      const toolUseId = String(block['tool_use_id'] ?? '');
      const isError = block['is_error'] === true;
      const text = truncate(resultToText(block['content']));
      const entry = this.toolViews.get(toolUseId);
      if (!entry) continue;

      entry.view.status = isError ? 'error' : 'success';
      entry.view.resultText = text;

      if (isEditTool(entry.view.name)) {
        if (isError) {
          // The edit never changed the file — drop its snapshot so a later
          // revert can't write this stale pre-edit content over newer work.
          this.deps.edits.discard(toolUseId);
        } else {
          const diff = await this.deps.edits.finalizeDiff(toolUseId);
          if (diff) entry.view.diff = diff;
        }
      }
      this.deps.post({ type: 'toolUpdate', messageId: entry.messageId, tool: entry.view });
    }
  }

  private markToolStatus(toolUseId: string, status: ToolUseView['status'], note?: string): void {
    const entry = this.toolViews.get(toolUseId);
    if (!entry) return;
    entry.view.status = status;
    if (note) entry.view.resultText = note;
    this.deps.post({ type: 'toolUpdate', messageId: entry.messageId, tool: entry.view });
  }

  private finishActiveMessage(usage?: UsageInfo): void {
    if (!this.activeMessage || !this.activeMessageId) return;
    this.activeMessage.streaming = false;
    this.deps.post({ type: 'assistantDone', messageId: this.activeMessageId, usage });
    this.activeMessage = undefined;
    this.activeMessageId = undefined;
    this.blockTypeByIndex.clear();
  }

  private handleResult(msg: Extract<SDKMessage, { type: 'result' }>): void {
    const usage = usageFromResult(msg, this.lastModel);
    // Prefer the last single API call's prompt size for context occupancy; the
    // aggregated result usage sums cache reads across the whole turn.
    if (usage && this.lastContextTokens !== undefined) {
      usage.contextTokens = this.lastContextTokens;
    }
    this.finishActiveMessage(usage);
    if (usage) {
      this.deps.onUsage?.(usage);
      this.deps.post({ type: 'usage', usage });
    }
    this.deps.post({ type: 'requestDone', usage });
    this.setBusy(false);
    this.deps.onTurnComplete?.(this.sessionId);
  }
}

function isReadOnly(name: string): boolean {
  return ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'BashOutput', 'Task'].includes(
    name,
  );
}

function usageFromResult(
  msg: Extract<SDKMessage, { type: 'result' }>,
  preferModel?: string,
): UsageInfo | undefined {
  const anyMsg = msg as unknown as {
    usage?: Record<string, number>;
    total_cost_usd?: number;
    duration_ms?: number;
    modelUsage?: Record<string, { contextWindow?: number }>;
  };
  const u = anyMsg.usage;
  if (!u) return undefined;
  const input = u['input_tokens'] ?? 0;
  const cacheRead = u['cache_read_input_tokens'] ?? 0;
  const cacheCreation = u['cache_creation_input_tokens'] ?? 0;
  const contextWindow = pickContextWindow(anyMsg.modelUsage, preferModel);
  return {
    inputTokens: input,
    outputTokens: u['output_tokens'] ?? 0,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    costUsd: anyMsg.total_cost_usd,
    durationMs: anyMsg.duration_ms,
    contextTokens: input + cacheRead + cacheCreation,
    contextWindow,
  };
}

/**
 * Choose the context window to divide by. A turn's `modelUsage` may list several
 * models (e.g. a Haiku subagent alongside the main model), each with a different
 * window. Prefer the window of the model that produced the last response; else
 * fall back to the largest window present (the primary model's).
 */
function pickContextWindow(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
  preferModel?: string,
): number | undefined {
  if (!modelUsage) return undefined;
  if (preferModel) {
    const w = modelUsage[preferModel]?.contextWindow;
    if (typeof w === 'number' && w > 0) return w;
  }
  let max: number | undefined;
  for (const entry of Object.values(modelUsage)) {
    if (entry && typeof entry.contextWindow === 'number' && entry.contextWindow > 0) {
      if (max === undefined || entry.contextWindow > max) max = entry.contextWindow;
    }
  }
  return max;
}
