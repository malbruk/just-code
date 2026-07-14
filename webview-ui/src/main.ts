/**
 * Webview bootstrap + message router.
 *
 * Flow:
 *   1. Build the DOM shell and post `{type:'ready'}`.
 *   2. Fold each `HostToWebview` message into `AppState` and update the UI.
 *   3. Post `WebviewToHost` messages in response to user actions.
 *
 * Everything is defensive: unknown message types are ignored and malformed
 * payloads never throw (they're just skipped).
 */
import type {
  HostToWebview,
  HistoryEntry,
  PermissionDecision,
} from '@just-code/core';
import { clock, chatPlus, search as searchIcon, trash } from './icons.js';
import { post, getPersisted, setPersisted } from './vscode.js';
import {
  createInitialState,
  applyInit,
  upsertUserMessage,
  applyStreamDelta,
  applyToolUpdate,
  ensureAssistantMessage,
  markDone,
  appendError,
  addPermission,
  resolvePermission,
  recomputeContextAttachments,
  removeAttachment,
  addAttachment,
  clearAttachments,
  appendMessage,
  settleEdit,
  type AppState,
} from './state.js';
import { Transcript, toolOutput } from './render.js';
import { Composer } from './composer.js';
import { AccountDialog } from './account.js';
import { imageSize } from './image.js';

const state: AppState = createInitialState();
const persisted = getPersisted();

// -- DOM shell --------------------------------------------------------------

const app = document.createElement('div');
app.className = 'app';
document.body.appendChild(app);

// Top header: the session title on the left, history + new-chat actions on the
// right — mirroring the layout of the official Claude Code panel.
const header = document.createElement('div');
header.className = 'chat-header';
const headerTitle = document.createElement('div');
headerTitle.className = 'chat-header-title';
headerTitle.textContent = 'Untitled';
const headerActions = document.createElement('div');
headerActions.className = 'chat-header-actions';
headerActions.innerHTML =
  `<button type="button" class="chat-header-btn" data-header-action="history" title="Chat history" aria-label="Chat history">${clock(17)}</button>` +
  `<button type="button" class="chat-header-btn" data-header-action="new-chat" title="New chat" aria-label="New chat">${chatPlus()}</button>`;
header.append(headerTitle, headerActions);

const scroller = document.createElement('div');
const footer = document.createElement('div');
footer.className = 'footer';
app.append(header, scroller, footer);

header.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-header-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-header-action');
  if (action === 'new-chat') startNewChat();
  else if (action === 'history') post({ type: 'requestHistory' });
});

/** Start a fresh conversation and dismiss the history overlay if it's open. */
function startNewChat(): void {
  post({ type: 'newChat' });
  state.messages = [];
  state.pendingPermissions = [];
  state.usage = undefined;
  state.sessionTitle = undefined;
  hideHistory();
  render();
}

/**
 * Derive the header title. The host supplies a short generated title once the
 * first turn completes; until then fall back to the first prompt's own text,
 * so the header is never blank mid-turn.
 */
function sessionTitle(s: AppState): string {
  if (s.sessionTitle) return s.sessionTitle;
  const firstUser = s.messages.find((m) => m.role === 'user');
  if (!firstUser) return 'Untitled';
  const text = firstUser.blocks
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'Untitled';
  return text.length > 60 ? text.slice(0, 60).trimEnd() + '…' : text;
}

function updateHeader(): void {
  const title = sessionTitle(state);
  headerTitle.textContent = title;
  headerTitle.title = title;
}

const transcript = new Transcript(scroller, {
  onFillComposer: (text) => composer.fill(text),
});

const composer = new Composer({
  onSubmit: (text, attachments) => {
    // Optimistically add the user's message so the UI feels instant even if the
    // host echoes it back later (upsert dedupes by id — the host uses its own id
    // so we render locally and let a later `userMessage` replace ours if sent).
    post({ type: 'submit', text, attachments });
    state.busy = true;
    // The attachments went out with this turn — drop them so they don't ride
    // along on the next one. Must happen before `composer.update`, which is
    // what repaints the chip row.
    clearAttachments(state);
    composer.update(state);
    transcript.forceScroll();
    setDraft('');
  },
  onStop: () => post({ type: 'stop' }),
  onRequestCompletions: (kind, query) => post({ type: 'requestCompletions', kind, query }),
  onRemoveAttachment: (index) => {
    post({ type: 'removeAttachment', index });
    removeAttachment(state, index);
    composer.update(state);
  },
  onAddImageAttachment: (attachment) => {
    addAttachment(state, attachment);
    composer.update(state);
  },
  onAttachmentError: (message) => {
    appendError(state, message);
    transcript.render(state);
    transcript.forceScroll();
  },
  onSetModel: (model) => {
    state.model = model;
    post({ type: 'setModel', model });
  },
  onSetPermissionMode: (mode) => {
    state.permissionMode = mode;
    post({ type: 'setPermissionMode', mode });
  },
  onNewChat: () => startNewChat(),
  onDraftChange: (text) => setDraft(text),
  onUploadFromComputer: () => post({ type: 'pickFiles' }),
  onSetEffort: (effort) => {
    state.effort = effort;
    post({ type: 'setEffort', effort });
  },
  onSetThinking: (enabled) => {
    state.extendedThinking = enabled;
    post({ type: 'setThinking', enabled });
  },
  onSetModelFallback: (enabled) => {
    state.autoModelFallback = enabled;
    post({ type: 'setModelFallback', enabled });
  },
  onRewind: () => {
    // Rewind to the last user turn (the SDK checkpoints file changes; the
    // transcript is trimmed to that point host-side).
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) post({ type: 'rewind', messageId: lastUser.id });
  },
  onOpenAccount: () => accountDialog.open(),
});

footer.appendChild(composer.root);

// Account & usage dialog — opened from the `/` menu and from the limit banner.
const accountDialog = new AccountDialog({
  onRequest: () => post({ type: 'requestAccountUsage' }),
  onOpenUrl: (url) => post({ type: 'openUrl', url }),
});
app.appendChild(accountDialog.root);

// Auth gate replaces the composer when signed out. Rendered per sign-in stage.
const authGate = document.createElement('div');
authGate.className = 'auth-gate';
authGate.hidden = true;
footer.appendChild(authGate);

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

// -- history popup ----------------------------------------------------------
// Populated when the host pushes a `history` message (triggered by the header
// clock button → `requestHistory`). Rendered as a small popup anchored under
// the header actions, not a full-screen takeover. Sessions come from the SDK's
// local transcript store, keyed to the signed-in Claude account.

const historyOverlay = document.createElement('div');
historyOverlay.className = 'history-overlay';
historyOverlay.hidden = true;
app.appendChild(historyOverlay);

let historyEntries: HistoryEntry[] = [];

/** Compact relative age for a history row, e.g. "now", "21m", "4h", "3d". */
function historyWhen(ms: number): string {
  if (!ms) return '';
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderHistory(entries: HistoryEntry[]): void {
  // The host re-pushes the list after a delete. That refresh must not discard
  // what the user has already typed into the filter.
  const open = !historyOverlay.hidden;
  const query = open ? currentHistoryQuery() : '';

  historyEntries = entries;
  historyOverlay.innerHTML =
    `<div class="history-panel" role="dialog" aria-label="Chat history">` +
    `<div class="history-search">${searchIcon()}` +
    `<input type="text" class="history-search-input" placeholder="Search sessions…" autocomplete="off" spellcheck="false" value="${esc(query)}" />` +
    `</div>` +
    `<div class="history-list-wrap"></div>` +
    `</div>`;
  renderHistoryList(query);
  const input = historyOverlay.querySelector<HTMLInputElement>('.history-search-input');
  if (input) setTimeout(() => input.focus(), 0);
}

function currentHistoryQuery(): string {
  return historyOverlay.querySelector<HTMLInputElement>('.history-search-input')?.value ?? '';
}

/** (Re)render the filtered session list inside the popup. */
function renderHistoryList(query: string): void {
  const wrap = historyOverlay.querySelector<HTMLElement>('.history-list-wrap');
  if (!wrap) return;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? historyEntries.filter((e) => e.title.toLowerCase().includes(q))
    : historyEntries;

  if (!filtered.length) {
    wrap.className = 'history-empty';
    wrap.textContent = historyEntries.length
      ? 'No matching conversations.'
      : 'No previous conversations yet.';
    return;
  }

  wrap.className = 'history-list';
  // The row is a div, not a button: it holds the open button *and* the delete
  // button, and nesting a button inside a button is invalid HTML.
  wrap.innerHTML = filtered
    .map(
      (e) =>
        `<div class="history-item">` +
        `<button type="button" class="history-item-open" data-session-open="${esc(e.sessionId)}">` +
        `<span class="history-item-title">${esc(e.title)}</span>` +
        `<span class="history-item-meta">${esc(historyWhen(e.updatedAt))}</span>` +
        `</button>` +
        `<button type="button" class="history-item-delete" data-session-delete="${esc(e.sessionId)}"` +
        ` title="Delete conversation" aria-label="Delete conversation">${trash()}</button>` +
        `</div>`,
    )
    .join('');
}

function hideHistory(): void {
  historyOverlay.hidden = true;
}

historyOverlay.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  // Clicking the transparent backdrop (anywhere outside the panel) dismisses it.
  if (target === historyOverlay) {
    hideHistory();
    return;
  }
  // Delete is checked first: its button sits inside the row, and it must not
  // also open the conversation it is about to remove. The host confirms and
  // then re-pushes the list, so the popup stays open.
  const del = target.closest('[data-session-delete]');
  if (del) {
    const sessionId = del.getAttribute('data-session-delete') ?? '';
    if (sessionId) post({ type: 'deleteSession', sessionId });
    return;
  }
  const item = target.closest('[data-session-open]');
  if (item) {
    const sessionId = item.getAttribute('data-session-open') ?? '';
    if (sessionId) post({ type: 'loadSession', sessionId });
    hideHistory();
  }
});

historyOverlay.addEventListener('input', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('history-search-input')) {
    renderHistoryList((target as HTMLInputElement).value);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (accountDialog.isOpen) {
    e.preventDefault();
    accountDialog.close();
  } else if (!historyOverlay.hidden) {
    e.preventDefault();
    hideHistory();
  }
});

function renderAuthGate(): void {
  if (state.signedIn) {
    authGate.hidden = true;
    return;
  }
  authGate.hidden = false;
  const stage = state.authStage;
  let body = '';

  if (stage === 'working') {
    body =
      `<div class="auth-title">Signing in…</div>` +
      `<div class="auth-working"><span class="spinner"></span><span>${esc(state.authMessage ?? 'Working…')}</span></div>`;
  } else if (stage === 'awaitingCode') {
    body =
      `<div class="auth-title">Finish signing in</div>` +
      `<p class="auth-sub">We opened your browser to approve access. Copy the code shown there and paste it below.</p>` +
      `<div class="auth-field">` +
      `<input type="text" class="auth-input" data-auth-input="code" placeholder="Paste your code here" autocomplete="off" spellcheck="false" />` +
      `<button type="button" class="btn btn-primary" data-auth="submitCode">Sign in</button>` +
      `</div>` +
      `<div class="auth-links">` +
      (state.authUrl ? `<button type="button" class="auth-link" data-auth="openurl">Reopen sign-in page</button>` : '') +
      `<button type="button" class="auth-link" data-auth="cancel">Cancel</button>` +
      `</div>`;
  } else if (stage === 'awaitingKey') {
    body =
      `<div class="auth-title">Enter your API key</div>` +
      `<p class="auth-sub">Paste an Anthropic API key. It is stored securely in VS Code secret storage.</p>` +
      `<div class="auth-field">` +
      `<input type="password" class="auth-input" data-auth-input="key" placeholder="sk-ant-…" autocomplete="off" spellcheck="false" />` +
      `<button type="button" class="btn btn-primary" data-auth="submitKey">Save</button>` +
      `</div>` +
      `<div class="auth-links"><button type="button" class="auth-link" data-auth="cancel">Back</button></div>`;
  } else if (stage === 'error') {
    body =
      `<div class="auth-title">Sign-in failed</div>` +
      `<p class="auth-sub auth-error">${esc(state.authMessage ?? 'Something went wrong.')}</p>` +
      `<button type="button" class="btn btn-primary" data-auth="retry">Try again</button>`;
  } else {
    // choose
    body =
      `<div class="auth-title">Sign in to Just Code</div>` +
      `<p class="auth-sub">Use your Claude subscription, or an Anthropic API key.</p>` +
      `<div class="auth-options">` +
      `<button type="button" class="auth-option" data-auth="subscription">` +
      `<span class="auth-option-title">Continue with Claude subscription</span>` +
      `<span class="auth-option-sub">Pro / Max — sign in with your claude.ai account</span></button>` +
      `<button type="button" class="auth-option" data-auth="apiKey">` +
      `<span class="auth-option-title">Use an API key</span>` +
      `<span class="auth-option-sub">Anthropic Console — usage billing</span></button>` +
      `</div>`;
  }

  authGate.innerHTML = `<div class="auth-inner">${body}</div>`;
  const input = authGate.querySelector<HTMLInputElement>('.auth-input');
  if (input) setTimeout(() => input.focus(), 0);
}

function authInputValue(name: string): string {
  return authGate.querySelector<HTMLInputElement>(`[data-auth-input="${name}"]`)?.value ?? '';
}

authGate.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-auth]');
  if (!btn) return;
  const action = btn.getAttribute('data-auth');
  switch (action) {
    case 'subscription':
      post({ type: 'signIn', method: 'subscription' });
      state.authStage = 'working';
      state.authMessage = 'Opening your browser…';
      renderAuthGate();
      break;
    case 'apiKey':
      post({ type: 'signIn', method: 'apiKey' });
      break;
    case 'submitCode': {
      const code = authInputValue('code').trim();
      if (code) post({ type: 'submitAuthCode', code });
      break;
    }
    case 'submitKey': {
      const key = authInputValue('key').trim();
      if (key) post({ type: 'submitApiKey', key });
      break;
    }
    case 'openurl':
      if (state.authUrl) post({ type: 'openUrl', url: state.authUrl });
      break;
    case 'cancel':
      post({ type: 'cancelAuth' });
      state.authStage = 'choose';
      renderAuthGate();
      break;
    case 'retry':
      state.authStage = 'choose';
      renderAuthGate();
      break;
  }
});

authGate.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target as HTMLElement;
  if (input.matches('[data-auth-input="code"]')) {
    const code = authInputValue('code').trim();
    if (code) post({ type: 'submitAuthCode', code });
  } else if (input.matches('[data-auth-input="key"]')) {
    const key = authInputValue('key').trim();
    if (key) post({ type: 'submitApiKey', key });
  }
});

// -- global event delegation (copy, open file, permissions) -----------------

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  const copyBtn = target.closest('.md-copy');
  if (copyBtn) {
    const code = copyBtn.closest('.md-pre')?.querySelector('code');
    if (code) {
      post({ type: 'copy', text: code.textContent ?? '' });
      flashCopied(copyBtn as HTMLElement);
    }
    return;
  }

  const outputEl = target.closest('[data-tool-output]');
  // Dragging across the OUT preview to copy a line ends in a click; that must
  // not yank the user into an editor tab.
  if (outputEl && !window.getSelection()?.toString()) {
    const toolUseId = outputEl.getAttribute('data-tool-output') ?? '';
    const out = toolOutput(toolUseId);
    if (out) post({ type: 'openToolOutput', toolUseId, toolName: out.name, text: out.text });
    return;
  }

  const openEl = target.closest('[data-openfile]');
  if (openEl) {
    const path = openEl.getAttribute('data-openfile') ?? '';
    const lineAttr = openEl.getAttribute('data-line');
    const line = lineAttr ? Number(lineAttr) : undefined;
    if (path) post({ type: 'openFile', path, line });
    return;
  }

  const editBtn = target.closest('[data-edit-decision]');
  if (editBtn) {
    const toolUseId = editBtn.getAttribute('data-tool-id') ?? '';
    if (toolUseId) {
      const accept = editBtn.getAttribute('data-edit-decision') === 'accept';
      post({ type: 'editDecision', toolUseId, accept });
      settleEdit(state, toolUseId);
      render();
    }
    return;
  }

  const permBtn = target.closest('[data-perm-decision]');
  if (permBtn) {
    const id = permBtn.getAttribute('data-perm-id') ?? '';
    const kind = permBtn.getAttribute('data-perm-decision');
    let decision: PermissionDecision;
    if (kind === 'deny') {
      decision = { behavior: 'deny' };
    } else if (kind === 'answer') {
      // `AskUserQuestion`: the card mirrors each resolved choice onto
      // `data-q-answer`, keyed by the question text the tool sent us.
      const answers: Record<string, string> = {};
      for (const q of Array.from(permBtn.closest('.ask-card')?.querySelectorAll('.ask-q') ?? [])) {
        const question = q.getAttribute('data-q-question');
        const answer = q.getAttribute('data-q-answer');
        if (question && answer) answers[question] = answer;
      }
      decision = { behavior: 'allow', answers };
    } else {
      decision = { behavior: 'allow', remember: kind === 'always' };
    }
    post({ type: 'permissionDecision', id, decision });
    resolvePermission(state, id);
    render();
    return;
  }

  const toolHeader = target.closest('.tool-header');
  if (toolHeader) {
    toolHeader.closest('.tool-card')?.classList.toggle('expanded');
    return;
  }
});

// Persist scroll position (throttled via rAF).
let scrollScheduled = false;
scroller.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    setPersisted({ draft: draft, scrollTop: transcript.getScrollTop() });
  });
});

// -- persisted draft --------------------------------------------------------

let draft = persisted.draft ?? '';
function setDraft(text: string): void {
  draft = text;
  setPersisted({ draft, scrollTop: transcript.getScrollTop() });
}
if (draft) composer.setDraft(draft);

// -- render -----------------------------------------------------------------

function render(): void {
  const signedIn = state.signedIn;
  composer.root.hidden = !signedIn;
  renderAuthGate();
  transcript.render(state);
  composer.update(state);
  updateHeader();
}

// -- message router ---------------------------------------------------------

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as HostToWebview | undefined;
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
  try {
    route(msg);
  } catch {
    /* never let a malformed message crash the UI */
  }
});

function route(msg: HostToWebview): void {
  switch (msg.type) {
    case 'init':
      applyInit(state, msg.state);
      // A new chat / loaded session arrives as a fresh `init`; make sure a
      // lingering history overlay doesn't hide the reset transcript.
      hideHistory();
      render();
      break;

    case 'userMessage':
      upsertUserMessage(state, msg.message);
      transcript.render(state);
      transcript.forceScroll();
      updateHeader();
      break;

    case 'assistantStart':
      ensureAssistantMessage(state, msg.messageId);
      transcript.refreshMessage(state, msg.messageId);
      break;

    case 'streamDelta':
      applyStreamDelta(state, msg.messageId, msg.blockType, msg.delta);
      transcript.refreshMessage(state, msg.messageId);
      break;

    case 'toolUpdate':
      applyToolUpdate(state, msg.messageId, msg.tool);
      transcript.refreshMessage(state, msg.messageId);
      break;

    case 'assistantDone':
      markDone(state, msg.messageId);
      if (msg.usage) state.usage = msg.usage;
      transcript.refreshMessage(state, msg.messageId);
      composer.update(state);
      break;

    case 'requestDone':
      state.busy = false;
      if (msg.usage) state.usage = msg.usage;
      for (const m of state.messages) m.streaming = false;
      render();
      break;

    case 'error':
      appendError(state, msg.message, msg.messageId);
      state.busy = false;
      render();
      break;

    case 'status':
      state.busy = msg.busy;
      composer.update(state);
      break;

    case 'permissionRequest':
      addPermission(state, msg.request);
      transcript.render(state);
      transcript.forceScroll();
      break;

    case 'permissionResolved':
      resolvePermission(state, msg.id);
      transcript.render(state);
      break;

    case 'editorContext':
      state.editorContext = msg.context;
      recomputeContextAttachments(state);
      composer.update(state);
      break;

    case 'settings':
      state.model = msg.model;
      state.permissionMode = msg.permissionMode;
      state.effort = msg.effort;
      state.extendedThinking = msg.extendedThinking;
      state.autoModelFallback = msg.autoModelFallback;
      composer.update(state);
      break;

    case 'usage':
      state.usage = msg.usage;
      composer.update(state);
      break;

    case 'openAccountDialog':
      accountDialog.open();
      break;

    case 'accountUsage':
      if (msg.usage) accountDialog.show(msg.usage);
      else accountDialog.showError(msg.error ?? 'Account and usage data is unavailable.');
      break;

    case 'rateLimitWarning':
      state.rateLimitWarning = msg.warning;
      composer.update(state);
      break;

    case 'sessionTitle':
      state.sessionTitle = msg.title;
      updateHeader();
      break;

    case 'history':
      renderHistory(msg.entries);
      historyOverlay.hidden = false;
      break;

    case 'completions':
      composer.showCompletions(msg.kind, msg.items);
      break;

    case 'appendMessage':
      appendMessage(state, msg.message);
      state.busy = false;
      render();
      transcript.forceScroll();
      break;

    case 'addAttachment': {
      const attachment = msg.attachment;
      addAttachment(state, attachment);
      composer.update(state);
      composer.focus();
      // The host builds image chips without dimensions (it never decodes the
      // bytes); measure here so an uploaded picture shows the same "W×H" as a
      // pasted one. `addAttachment` stores the object itself, so mutating it is
      // enough — only a re-render is needed.
      if (attachment.kind === 'image' && attachment.dataUri && !attachment.width) {
        void imageSize(attachment.dataUri).then((size) => {
          if (!size || !state.pinned.includes(attachment)) return;
          Object.assign(attachment, size);
          composer.update(state);
        });
      }
      break;
    }

    case 'seedInput':
      composer.fill(msg.text);
      if (msg.focus !== false) composer.focus();
      break;

    case 'focusInput':
      composer.focus();
      break;

    case 'authState':
      state.signedIn = msg.signedIn;
      // Reset to the method chooser whenever we land on the signed-out gate,
      // unless a sign-in flow is actively mid-stream.
      if (!msg.signedIn && (state.authStage === 'working' || state.authStage === 'choose')) {
        state.authStage = 'choose';
      }
      render();
      break;

    case 'authPrompt':
      state.authStage = msg.stage;
      state.authMethod = msg.method;
      state.authUrl = msg.url;
      state.authMessage = msg.message;
      renderAuthGate();
      break;

    default:
      // Unknown message type — ignore.
      break;
  }
}

function flashCopied(btn: HTMLElement): void {
  const label = btn.querySelector('span');
  if (!label) return;
  const prev = label.textContent;
  label.textContent = 'Copied';
  btn.classList.add('copied');
  setTimeout(() => {
    label.textContent = prev;
    btn.classList.remove('copied');
  }, 1200);
}

// -- boot -------------------------------------------------------------------

render();
post({ type: 'ready' });
