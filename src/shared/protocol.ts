/**
 * Shared message protocol between the extension host and the webview UI.
 *
 * This file is imported by BOTH the extension host (`src/`) and the webview
 * (`webview-ui/`). It must have zero runtime dependencies on `vscode` or DOM
 * APIs — types and plain constants only.
 *
 * Direction naming:
 *   - `HostToWebview` : messages the extension host posts to the webview.
 *   - `WebviewToHost` : messages the webview posts back to the host.
 */

/** Permission modes, mirroring the Agent SDK `PermissionMode`. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** How the extension authenticates with Anthropic. */
export type AuthMethod = 'subscription' | 'apiKey';

/** Auth state surfaced to the UI. */
export interface AuthInfo {
  signedIn: boolean;
  method?: AuthMethod;
  /** Signed-in account email, when known (subscription login). */
  email?: string;
  /** Subscription tier, e.g. "pro" | "max", when known. */
  plan?: string;
}

/**
 * Stage of the in-panel sign-in flow, driving the auth gate UI:
 *   - `choose`        pick subscription vs API key
 *   - `awaitingCode`  browser opened; paste the OAuth code
 *   - `awaitingKey`   enter an Anthropic API key
 *   - `working`       finishing sign-in
 *   - `error`         show a message and let the user retry
 */
export type AuthStage = 'choose' | 'awaitingCode' | 'awaitingKey' | 'working' | 'error';

/** A model choice surfaced in the UI. `default` means "account default". */
export type ModelId = 'default' | 'claude-opus-4-8' | 'claude-sonnet-5' | 'claude-haiku-4-5-20251001';

/**
 * Reasoning effort level (SDK `Options.effort`). `default` leaves the model
 * default (`high`) in place; the others map 1:1 onto the SDK's named levels.
 */
export type EffortLevel = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Ordered effort levels shown in the composer's Effort selector. */
export const EFFORT_LEVELS: Exclude<EffortLevel, 'default'>[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ModelInfo {
  id: ModelId;
  label: string;
  description: string;
}

export const MODELS: ModelInfo[] = [
  { id: 'default', label: 'Default', description: 'Account default model' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Most capable' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Balanced speed and capability' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fastest' },
];

// ---------------------------------------------------------------------------
// Chat content model
// ---------------------------------------------------------------------------

export type ChatRole = 'user' | 'assistant' | 'system';

/** A rendered block within an assistant/user turn. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; startedAt?: number; endedAt?: number }
  | { type: 'tool_use'; toolUse: ToolUseView }
  | { type: 'error'; text: string };

/** Status of a single tool invocation as shown in the UI. */
export type ToolStatus = 'pending' | 'running' | 'success' | 'error' | 'denied';

/** A view-model for a tool invocation, rendered as a collapsible card. */
export interface ToolUseView {
  /** Stable id (the SDK tool_use id). */
  id: string;
  /** Tool name, e.g. "Read", "Edit", "Bash", "Grep". */
  name: string;
  /** Raw input arguments. */
  input: Record<string, unknown>;
  status: ToolStatus;
  /** Human-friendly one-line summary, e.g. "Read src/index.ts (120 lines)". */
  title?: string;
  /** Result text/preview (truncated for display). */
  resultText?: string;
  /** For edit/write tools: a diff to render inline. */
  diff?: DiffView;
  /** Whether this tool required and received a permission decision. */
  requiresPermission?: boolean;
}

export interface DiffView {
  path: string;
  /** Unified-diff style hunks or before/after; the UI renders line-by-line. */
  before?: string;
  after?: string;
  additions: number;
  deletions: number;
  /** True while the edit is applied to the working tree but not yet accepted. */
  pending?: boolean;
}

/** A full message turn in the transcript. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  blocks: ContentBlock[];
  /** True while the assistant turn is still streaming. */
  streaming?: boolean;
  /** Attachments the user included (files/selection). */
  attachments?: Attachment[];
  createdAt: number;
}

export interface Attachment {
  kind: 'file' | 'selection' | 'image';
  /** Workspace-relative path for file/selection. */
  path?: string;
  label: string;
  /** For selection: 1-based inclusive line range. */
  range?: { startLine: number; endLine: number };
  /** For image: data URI. */
  dataUri?: string;
  /** UI hint: this chip auto-tracks the active editor rather than being pinned. */
  ephemeral?: boolean;
  /**
   * UI hint: this attachment came from *outside* the project (uploaded from the
   * user's computer). External attachments render *above* the input; project
   * files (`@`-mentions, editor context) render *below* it, mirroring Claude Code.
   */
  external?: boolean;
}

/** Token/cost usage for a turn or the whole session. */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  durationMs?: number;
  contextTokens?: number;
  contextWindow?: number;
}

/** Editor context pushed to the webview so it can render chips/@-mentions. */
export interface EditorContext {
  activeFile?: string;
  selection?: { path: string; startLine: number; endLine: number; text: string };
  openFiles: string[];
  workspaceName?: string;
}

/** A pending permission request awaiting user decision. */
export interface PermissionRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Human summary of what will happen. */
  title: string;
  /** Optional diff preview for edit/write tools. */
  diff?: DiffView;
  /** Suggestions the UI can offer as "always allow" scopes. */
  canRemember?: boolean;
}

export type PermissionDecision =
  | { behavior: 'allow'; remember?: boolean }
  | { behavior: 'deny'; message?: string };

/** A saved conversation summary for the history view. */
export interface HistoryEntry {
  sessionId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/** A slash command surfaced in the input autocomplete. */
export interface SlashCommand {
  name: string;
  description: string;
  /** Optional hint for arguments, e.g. "[model]" or "<path>". */
  argHint?: string;
}

// ---------------------------------------------------------------------------
// Host -> Webview
// ---------------------------------------------------------------------------

export type HostToWebview =
  /** Full state replace, e.g. on load or when switching sessions. */
  | { type: 'init'; state: WebviewState }
  /** A new user message was accepted and added to the transcript. */
  | { type: 'userMessage'; message: ChatMessage }
  /** Start of a new assistant turn. */
  | { type: 'assistantStart'; messageId: string }
  /** Streaming text/thinking delta for the current assistant turn. */
  | { type: 'streamDelta'; messageId: string; blockType: 'text' | 'thinking'; delta: string }
  /** A tool invocation was created/updated. */
  | { type: 'toolUpdate'; messageId: string; tool: ToolUseView }
  /** The assistant turn finished. */
  | { type: 'assistantDone'; messageId: string; usage?: UsageInfo }
  /** The whole request finished (result message). */
  | { type: 'requestDone'; usage?: UsageInfo }
  /** A recoverable error to show inline. */
  | { type: 'error'; message: string; messageId?: string }
  /** Busy/idle state for the input + stop button. */
  | { type: 'status'; busy: boolean }
  /** Request the user approve/deny a tool. */
  | { type: 'permissionRequest'; request: PermissionRequest }
  /** Resolve/cancel an outstanding permission request in the UI. */
  | { type: 'permissionResolved'; id: string }
  /** Push updated editor context (selection, open files). */
  | { type: 'editorContext'; context: EditorContext }
  /** Update the current model / permission mode / reasoning indicators. */
  | {
      type: 'settings';
      model: ModelId;
      permissionMode: PermissionMode;
      effort: EffortLevel;
      extendedThinking: boolean;
      autoModelFallback: boolean;
    }
  /** Update session usage totals. */
  | { type: 'usage'; usage: UsageInfo }
  /** Provide the history list. */
  | { type: 'history'; entries: HistoryEntry[] }
  /** Provide slash-command / @-file completion candidates. */
  | { type: 'completions'; kind: 'slash' | 'file'; items: CompletionItem[] }
  /** Append a system/assistant message to the transcript (e.g. slash-command output). */
  | { type: 'appendMessage'; message: ChatMessage }
  /** Pin an attachment (selection/file) into the composer without submitting. */
  | { type: 'addAttachment'; attachment: Attachment }
  /** Pre-fill the composer input (e.g. from a command) without submitting. */
  | { type: 'seedInput'; text: string; focus?: boolean }
  /** Move keyboard focus to the composer input. */
  | { type: 'focusInput' }
  /** Sign-in state changed. */
  | { type: 'authState'; signedIn: boolean; auth?: AuthInfo }
  /** Drive the in-panel sign-in UI. */
  | { type: 'authPrompt'; stage: AuthStage; method?: AuthMethod; url?: string; message?: string };

export interface CompletionItem {
  label: string;
  /** Text to insert. */
  insert: string;
  detail?: string;
}

export interface WebviewState {
  messages: ChatMessage[];
  model: ModelId;
  permissionMode: PermissionMode;
  /** Reasoning effort level (SDK `Options.effort`). */
  effort: EffortLevel;
  /** Whether extended thinking is enabled (SDK `thinking`). */
  extendedThinking: boolean;
  /** Whether to fall back to another model when the primary is flagged/fails. */
  autoModelFallback: boolean;
  busy: boolean;
  editorContext: EditorContext;
  usage?: UsageInfo;
  signedIn: boolean;
  auth?: AuthInfo;
  slashCommands: SlashCommand[];
}

// ---------------------------------------------------------------------------
// Webview -> Host
// ---------------------------------------------------------------------------

export type WebviewToHost =
  /** Webview finished loading and is ready to receive `init`. */
  | { type: 'ready' }
  /** Send a new prompt. */
  | { type: 'submit'; text: string; attachments: Attachment[] }
  /** Interrupt the running request. */
  | { type: 'stop' }
  /** Start a fresh conversation. */
  | { type: 'newChat' }
  /** User answered a permission request. */
  | { type: 'permissionDecision'; id: string; decision: PermissionDecision }
  /** Change model. */
  | { type: 'setModel'; model: ModelId }
  /** Change permission mode. */
  | { type: 'setPermissionMode'; mode: PermissionMode }
  /** Change reasoning effort level (applies to the next chat/turn). */
  | { type: 'setEffort'; effort: EffortLevel }
  /** Toggle extended thinking (applied live via the SDK). */
  | { type: 'setThinking'; enabled: boolean }
  /** Toggle "switch models when a message is flagged" (fallback model). */
  | { type: 'setModelFallback'; enabled: boolean }
  /** Accept/reject a pending edit produced by a tool. */
  | { type: 'editDecision'; toolUseId: string; accept: boolean }
  | { type: 'acceptAllEdits' }
  | { type: 'rejectAllEdits' }
  /** Open a file (optionally at a line) in the editor. */
  | { type: 'openFile'; path: string; line?: number }
  /** Show a diff for a tool result. */
  | { type: 'showDiff'; toolUseId: string }
  /** Request history entries. */
  | { type: 'requestHistory' }
  /** Load a session from history. */
  | { type: 'loadSession'; sessionId: string }
  /** Ask host for completions as the user types. */
  | { type: 'requestCompletions'; kind: 'slash' | 'file'; query: string }
  /** Remove an attachment chip. */
  | { type: 'removeAttachment'; index: number }
  /** Open a native file picker to attach file(s) from the user's computer. */
  | { type: 'pickFiles' }
  /** Add the current editor selection (or active file) as a project attachment. */
  | { type: 'addContext' }
  /** Rewind to a checkpoint (message id). */
  | { type: 'rewind'; messageId: string }
  /** Begin (or restart) the sign-in flow; `method` picks the path directly. */
  | { type: 'signIn'; method?: AuthMethod }
  /** Submit the OAuth code pasted from the browser (subscription flow). */
  | { type: 'submitAuthCode'; code: string }
  /** Submit an Anthropic API key (apiKey flow). */
  | { type: 'submitApiKey'; key: string }
  /** Cancel an in-progress sign-in flow. */
  | { type: 'cancelAuth' }
  /** Open an external URL in the system browser (via the host). */
  | { type: 'openUrl'; url: string }
  /** Sign out of the current account. */
  | { type: 'signOut' }
  /** Copy text to clipboard via host (webview clipboard is restricted). */
  | { type: 'copy'; text: string };
