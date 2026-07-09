/**
 * Transcript rendering. Owns the scrollable message list, the permission cards
 * and the empty state. Rendering is (mostly) a pure function of `AppState`;
 * streaming updates re-render only the single affected message element for
 * smoothness, while structural changes do a full reconcile.
 */
import type {
  ChatMessage,
  ContentBlock,
  DiffView,
  PermissionRequest,
  ToolUseView,
} from '../../src/shared/protocol.js';
import type { AppState } from './state.js';
import { renderMarkdown, escapeHtml, firstStrongDir } from './markdown.js';
import {
  check,
  cross,
  deny as denyIcon,
  chevron,
  file as fileIcon,
  code as codeIcon,
  terminal as terminalIcon,
  search as searchIcon,
  pencil as pencilIcon,
  globe as globeIcon,
  list as listIcon,
  sparkle as sparkleIcon,
  logo,
} from './icons.js';

/**
 * Remembers the raw source text a text/thinking block element was last rendered
 * from, so streaming updates can skip re-parsing markdown when nothing changed.
 */
const blockText = new WeakMap<HTMLElement, string>();

/**
 * Pin the base direction of a text container, once, on the first strong character.
 *
 * The `dir="auto"` on each rendered paragraph already handles mixed Hebrew/English
 * content, but a paragraph that has not yet streamed a strong character inherits
 * its parent's direction. Latching that parent the moment the direction becomes
 * knowable — and never recomputing it afterwards — means a response that opens with
 * punctuation, a number or a code span does not visibly flip sides once the first
 * Hebrew letter arrives. Direction is therefore decided at most once per block.
 */
function latchDir(el: HTMLElement, text: string): void {
  if (el.dataset.dirLatched) return;
  const dir = firstStrongDir(text);
  if (!dir) return;
  el.dir = dir;
  el.dataset.dirLatched = '1';
}

const EXAMPLE_PROMPTS = [
  'Explain what this project does',
  'Find and fix the bug in the current file',
  'Add tests for the selected function',
  'Refactor this file for readability',
];

export interface TranscriptCallbacks {
  onFillComposer: (text: string) => void;
}

export class Transcript {
  private readonly scroller: HTMLElement;
  private readonly messagesEl: HTMLElement;
  private readonly permissionsEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private autoScroll = true;

  constructor(root: HTMLElement, private readonly cb: TranscriptCallbacks) {
    this.scroller = root;
    this.scroller.classList.add('transcript');
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'empty-state';
    this.messagesEl = document.createElement('div');
    this.messagesEl.className = 'messages';
    this.permissionsEl = document.createElement('div');
    this.permissionsEl.className = 'permissions';
    this.scroller.append(this.emptyEl, this.messagesEl, this.permissionsEl);

    this.scroller.addEventListener('scroll', () => {
      const nearBottom =
        this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 60;
      this.autoScroll = nearBottom;
    });

    this.emptyEl.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest('[data-example]');
      if (chip) this.cb.onFillComposer(chip.getAttribute('data-example') ?? '');
    });
  }

  /**
   * Reconcile the message list. Existing message elements are updated *in place*
   * (never replaced wholesale) so streaming never re-triggers entry animations or
   * loses expand/scroll state. Messages only ever append in chronological order,
   * so new elements are appended at the end.
   */
  render(state: AppState): void {
    const hasContent = state.messages.length > 0 || state.pendingPermissions.length > 0;
    this.emptyEl.style.display = hasContent ? 'none' : '';
    if (!hasContent) this.renderEmpty();

    const seen = new Set<string>();
    for (const msg of state.messages) {
      seen.add(msg.id);
      const el = this.messagesEl.querySelector<HTMLElement>(`[data-id="${cssEscape(msg.id)}"]`);
      if (el) {
        this.syncMessage(el, msg);
      } else {
        this.messagesEl.appendChild(this.renderMessage(msg));
      }
    }
    // Drop stale.
    for (const child of Array.from(this.messagesEl.children)) {
      const id = child.getAttribute('data-id');
      if (id && !seen.has(id)) child.remove();
    }

    this.renderPermissions(state.pendingPermissions);
    this.scrollIfNeeded();
  }

  /** Update a single message in place (used for streaming/tool updates). */
  refreshMessage(state: AppState, id: string): void {
    const msg = state.messages.find((m) => m.id === id);
    if (!msg) {
      this.render(state);
      return;
    }
    const existing = this.messagesEl.querySelector<HTMLElement>(`[data-id="${cssEscape(id)}"]`);
    if (existing) this.syncMessage(existing, msg);
    else this.messagesEl.appendChild(this.renderMessage(msg));
    this.emptyEl.style.display = 'none';
    this.scrollIfNeeded();
  }

  /**
   * Update an already-rendered message element to match `msg`, mutating the DOM
   * as little as possible. User turns are immutable once rendered; assistant and
   * system turns reconcile their blocks in place.
   */
  private syncMessage(el: HTMLElement, msg: ChatMessage): void {
    if (msg.role === 'user') return;
    const body = el.querySelector<HTMLElement>(':scope > .msg-body');
    if (body) this.reconcileBlocks(body, msg);
  }

  forceScroll(): void {
    this.autoScroll = true;
    this.scrollIfNeeded();
  }

  getScrollTop(): number {
    return this.scroller.scrollTop;
  }

  private scrollIfNeeded(): void {
    if (this.autoScroll) {
      requestAnimationFrame(() => {
        this.scroller.scrollTop = this.scroller.scrollHeight;
      });
    }
  }

  // -- rendering helpers ----------------------------------------------------

  private renderEmpty(): void {
    const prompts = EXAMPLE_PROMPTS.map(
      (p) => `<button class="example-chip" type="button" data-example="${escapeHtml(p)}">${escapeHtml(p)}</button>`,
    ).join('');
    this.emptyEl.innerHTML =
      `<div class="empty-inner">` +
      `<div class="empty-logo">${logo(40)}</div>` +
      `<h1 class="empty-title">Yes Code</h1>` +
      `<p class="empty-sub">Ask about your codebase, edit files, run commands. Here are a few ideas:</p>` +
      `<div class="example-grid">${prompts}</div>` +
      `</div>`;
  }

  private renderMessage(msg: ChatMessage): HTMLElement {
    const el = document.createElement('div');
    el.className = `msg msg-${msg.role}`;
    el.setAttribute('data-id', msg.id);

    if (msg.role === 'user') {
      el.appendChild(this.renderUser(msg));
      return el;
    }

    const body = document.createElement('div');
    body.className = 'msg-body';
    this.reconcileBlocks(body, msg);
    el.appendChild(body);
    return el;
  }

  /**
   * Reconcile the block children of a `.msg-body` against `msg.blocks`, updating
   * matching blocks in place and only creating/removing what actually changed.
   * Blocks are keyed by their index (the block list only ever appends, and a
   * given index never changes type). The blinking caret is removed and re-placed
   * at the tail of the streaming text so it reads as a typing cursor.
   */
  private reconcileBlocks(body: HTMLElement, msg: ChatMessage): void {
    body.querySelector(':scope .caret')?.remove();

    const blocks = msg.blocks;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const child = body.querySelector<HTMLElement>(`:scope > [data-block-index="${i}"]`);
      if (child && child.getAttribute('data-block-type') === block.type) {
        this.updateBlock(child, block);
      } else if (child) {
        child.replaceWith(this.createBlockEl(block, i));
      } else {
        body.appendChild(this.createBlockEl(block, i));
      }
    }
    // Drop any blocks that no longer exist.
    body.querySelectorAll<HTMLElement>(':scope > [data-block-index]').forEach((child) => {
      if (Number(child.getAttribute('data-block-index')) >= blocks.length) child.remove();
    });

    if (msg.streaming) {
      const caret = document.createElement('span');
      caret.className = 'caret';
      const children = body.querySelectorAll<HTMLElement>(':scope > [data-block-index]');
      const last = children[children.length - 1];
      const lastMain = last?.querySelector<HTMLElement>(':scope > .step-main.block-text');
      if (lastMain) {
        // Tuck the cursor at the very end of the last paragraph so it reads as a
        // typing caret rather than dropping onto its own line.
        const tail = lastMain.querySelector<HTMLElement>(':scope > :last-child') ?? lastMain;
        tail.appendChild(caret);
      } else {
        body.appendChild(caret);
      }
    }
  }

  private createBlockEl(block: ContentBlock, index: number): HTMLElement {
    const el = this.renderBlock(block);
    el.setAttribute('data-block-index', String(index));
    el.setAttribute('data-block-type', block.type);
    if (block.type === 'text' || block.type === 'thinking') blockText.set(el, block.text);
    return el;
  }

  /** Update an existing block element in place without rebuilding the step. */
  private updateBlock(el: HTMLElement, block: ContentBlock): void {
    const main = el.querySelector<HTMLElement>(':scope > .step-main');
    switch (block.type) {
      case 'text':
        if (main && blockText.get(el) !== block.text) {
          main.innerHTML = renderMarkdown(block.text);
          latchDir(main, block.text);
          blockText.set(el, block.text);
        }
        break;
      case 'thinking': {
        const label = el.querySelector<HTMLElement>('.thinking-label');
        if (label) label.textContent = thinkingLabel(block);
        el.querySelector('.thinking')?.classList.toggle('empty', !block.text.trim());
        const bodyEl = el.querySelector<HTMLElement>('.thinking-body');
        if (bodyEl && blockText.get(el) !== block.text) {
          bodyEl.innerHTML = renderMarkdown(block.text);
          latchDir(bodyEl, block.text);
          blockText.set(el, block.text);
        }
        break;
      }
      case 'tool_use': {
        const dot = el.querySelector<HTMLElement>(':scope > .step-dot');
        if (dot) this.applyDot(dot, block.toolUse.status);
        if (main) {
          const old = main.querySelector<HTMLElement>('.tool-card');
          const wasExpanded = old?.classList.contains('expanded') ?? false;
          const fresh = this.renderTool(block.toolUse);
          if (wasExpanded) fresh.classList.add('expanded');
          main.replaceChildren(fresh);
        }
        break;
      }
      case 'error':
        if (main) main.textContent = block.text;
        break;
    }
  }

  private renderUser(msg: ChatMessage): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'user-wrap';

    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';

    // Attachment chips live *inside* the box, at the top (native-extension style).
    if (msg.attachments && msg.attachments.length) {
      const chips = document.createElement('div');
      chips.className = 'msg-chips';
      for (const a of msg.attachments) {
        const chip = document.createElement('span');
        chip.className = 'chip chip-static';
        chip.innerHTML = `${codeIcon()}<span class="chip-label">${escapeHtml(a.label)}</span>`;
        chips.appendChild(chip);
      }
      bubble.appendChild(chips);
    }

    const textEl = document.createElement('div');
    textEl.className = 'user-text markdown';
    const text = msg.blocks
      .map((b) => (b.type === 'text' || b.type === 'thinking' || b.type === 'error' ? b.text : ''))
      .join('\n')
      .trim();
    textEl.innerHTML = renderMarkdown(text);
    latchDir(textEl, text);
    bubble.appendChild(textEl);

    wrap.appendChild(bubble);
    return wrap;
  }

  /**
   * A block is a timeline "step": a status dot on the left and the content on
   * the right, mirroring the native extension's transcript layout.
   */
  private renderBlock(block: ContentBlock): HTMLElement {
    const step = document.createElement('div');
    step.className = 'step';
    const dot = document.createElement('span');
    dot.className = 'step-dot';
    const main = document.createElement('div');
    main.className = 'step-main';

    switch (block.type) {
      case 'text':
        main.className = 'step-main block-text markdown';
        main.innerHTML = renderMarkdown(block.text);
        latchDir(main, block.text);
        break;
      case 'thinking':
        main.appendChild(this.renderThinking(block));
        break;
      case 'tool_use':
        this.applyDot(dot, block.toolUse.status);
        main.appendChild(this.renderTool(block.toolUse));
        break;
      case 'error':
        dot.classList.add('dot-error');
        main.className = 'step-main block-error';
        main.dir = 'auto';
        main.textContent = block.text;
        break;
    }

    step.append(dot, main);
    return step;
  }

  /** Colour/animate a step dot to reflect a tool's status. */
  private applyDot(dot: HTMLElement, status: ToolUseView['status']): void {
    dot.className = 'step-dot';
    if (status === 'running' || status === 'pending') {
      dot.classList.add('dot-running');
      dot.innerHTML = '<span class="spinner"></span>';
    } else {
      dot.innerHTML = '';
      if (status === 'success') dot.classList.add('dot-success');
      else if (status === 'error') dot.classList.add('dot-error');
      else if (status === 'denied') dot.classList.add('dot-denied');
    }
  }

  private renderThinking(block: Extract<ContentBlock, { type: 'thinking' }>): HTMLElement {
    const details = document.createElement('details');
    details.className = 'thinking';
    if (!block.text.trim()) details.classList.add('empty');
    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="thinking-label"></span>${chevron()}`;
    summary.querySelector('.thinking-label')!.textContent = thinkingLabel(block);
    const body = document.createElement('div');
    body.className = 'thinking-body markdown';
    body.innerHTML = renderMarkdown(block.text);
    latchDir(body, block.text);
    details.append(summary, body);
    return details;
  }

  private renderTool(tool: ToolUseView): HTMLElement {
    const card = document.createElement('div');
    card.className = `tool-card tool-${tool.status}`;
    card.setAttribute('data-tool-id', tool.id);

    const isBash = /^(bash|shell)$/i.test(tool.name);
    const command = typeof tool.input?.command === 'string' ? (tool.input.command as string) : '';
    const summary = toolSummary(tool);
    // Bash/edit steps show their command/diff inline by default, like the native UI.
    if (isBash || tool.diff) card.classList.add('expanded');

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'tool-header';
    header.innerHTML =
      `<span class="tool-name">${escapeHtml(tool.name)}</span>` +
      (summary ? `<span class="tool-title">${escapeHtml(summary)}</span>` : '') +
      `<span class="tool-caret">${chevron()}</span>`;
    card.appendChild(header);

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'tool-body';

    if (isBash) {
      // Terminal-style IN / OUT panel.
      bodyWrap.appendChild(renderIO(command || summary, tool.resultText));
    } else {
      const path = typeof tool.input?.path === 'string' ? (tool.input.path as string) : tool.diff?.path;
      if (path) {
        const fileRow = document.createElement('button');
        fileRow.type = 'button';
        fileRow.className = 'tool-file';
        fileRow.setAttribute('data-openfile', path);
        fileRow.innerHTML = `${fileIcon()}<span>${escapeHtml(path)}</span>`;
        bodyWrap.appendChild(fileRow);
      }

      if (tool.diff) {
        const sub = document.createElement('div');
        sub.className = 'tool-sub';
        sub.textContent = diffSummary(tool.diff);
        bodyWrap.appendChild(sub);
        bodyWrap.appendChild(renderDiff(tool.diff));
      }

      if (!tool.diff) {
        const inputStr = safeStringify(tool.input);
        if (inputStr && inputStr !== '{}') {
          const inputEl = document.createElement('pre');
          inputEl.className = 'tool-input';
          inputEl.textContent = inputStr;
          bodyWrap.appendChild(inputEl);
        }
        if (tool.resultText) {
          const result = document.createElement('div');
          result.className = 'tool-result';
          const pre = document.createElement('pre');
          pre.className = 'tool-result-pre';
          const truncated =
            tool.resultText.length > 4000 ? tool.resultText.slice(0, 4000) + '\n…' : tool.resultText;
          pre.textContent = truncated;
          result.appendChild(pre);
          bodyWrap.appendChild(result);
        }
      }
    }

    card.appendChild(bodyWrap);
    return card;
  }

  private renderPermissions(reqs: PermissionRequest[]): void {
    const seen = new Set(reqs.map((r) => r.id));
    for (const child of Array.from(this.permissionsEl.children)) {
      const id = child.getAttribute('data-perm-id');
      if (id && !seen.has(id)) child.remove();
    }
    for (const req of reqs) {
      if (this.permissionsEl.querySelector(`[data-perm-id="${cssEscape(req.id)}"]`)) continue;
      this.permissionsEl.appendChild(renderPermissionCard(req));
    }
  }
}

// -- module-level render helpers -------------------------------------------

function renderPermissionCard(req: PermissionRequest): HTMLElement {
  const card = document.createElement('div');
  card.className = 'perm-card';
  card.setAttribute('data-perm-id', req.id);

  const head = document.createElement('div');
  head.className = 'perm-head';
  head.innerHTML =
    `<span class="perm-icon">${toolIcon(req.toolName)}</span>` +
    `<span class="perm-q">Allow <span class="perm-tool">${escapeHtml(req.toolName)}</span>?</span>`;
  card.appendChild(head);

  const title = document.createElement('div');
  title.className = 'perm-title';
  title.textContent = req.title;
  card.appendChild(title);

  if (req.diff) card.appendChild(renderDiff(req.diff));

  const actions = document.createElement('div');
  actions.className = 'perm-actions';
  actions.innerHTML =
    `<button type="button" class="btn btn-primary" data-perm-decision="allow" data-perm-id="${escapeHtml(req.id)}">Allow</button>` +
    (req.canRemember
      ? `<button type="button" class="btn" data-perm-decision="always" data-perm-id="${escapeHtml(req.id)}">Allow always</button>`
      : '') +
    `<button type="button" class="btn btn-ghost" data-perm-decision="deny" data-perm-id="${escapeHtml(req.id)}">No</button>`;
  card.appendChild(actions);
  return card;
}

function renderDiff(diff: DiffView): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'diff';
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'diff-head';
  head.setAttribute('data-openfile', diff.path);
  head.innerHTML =
    `${fileIcon()}<span class="diff-path">${escapeHtml(diff.path)}</span>` +
    `<span class="diff-badge"><span class="add">+${diff.additions}</span> <span class="del">-${diff.deletions}</span></span>` +
    (diff.pending ? `<span class="diff-pending">pending</span>` : '');
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'diff-body';

  // `before`/`after` are full-file snapshots — compute an actual line diff and
  // show only the changed lines with a little surrounding context, like the
  // native diff view (rather than dumping the whole file as -/+).
  const rows = collapseDiff(diffRows(diff.before ?? '', diff.after ?? ''));
  for (const row of rows) {
    if (row.kind === 'gap') {
      const gap = document.createElement('div');
      gap.className = 'diff-gap';
      gap.innerHTML = `<span class="diff-gutter">⋯</span><span class="diff-code"></span>`;
      body.appendChild(gap);
      continue;
    }
    const el = document.createElement('div');
    el.className = `diff-line ${row.kind}`;
    const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
    const no = row.kind === 'del' ? row.oldNo : row.newNo;
    el.innerHTML =
      `<span class="diff-no">${no ?? ''}</span>` +
      `<span class="diff-gutter">${sign}</span>` +
      `<span class="diff-code"></span>`;
    el.querySelector('.diff-code')!.textContent = row.text;
    body.appendChild(el);
  }

  wrap.appendChild(body);
  return wrap;
}

type DiffRow =
  | { kind: 'ctx' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number }
  | { kind: 'gap' };

/** LCS line diff producing an ordered add/del/context row list with line numbers. */
function diffRows(before: string, after: string): DiffRow[] {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: 'del', text: a[i], oldNo: oldNo++ });
      i++;
    } else {
      rows.push({ kind: 'add', text: b[j], newNo: newNo++ });
      j++;
    }
  }
  while (i < n) rows.push({ kind: 'del', text: a[i++], oldNo: oldNo++ });
  while (j < m) rows.push({ kind: 'add', text: b[j++], newNo: newNo++ });
  return rows;
}

/** Keep changed lines plus `context` neighbours; collapse the rest into gaps. */
function collapseDiff(rows: DiffRow[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, idx) => {
    if (r.kind !== 'ctx') {
      for (let k = idx - context; k <= idx + context; k++) {
        if (k >= 0 && k < rows.length) keep[k] = true;
      }
    }
  });
  const out: DiffRow[] = [];
  let inGap = false;
  for (let idx = 0; idx < rows.length; idx++) {
    if (keep[idx]) {
      out.push(rows[idx]);
      inGap = false;
    } else if (!inGap) {
      out.push({ kind: 'gap' });
      inGap = true;
    }
  }
  return out;
}

function thinkingLabel(block: Extract<ContentBlock, { type: 'thinking' }>): string {
  if (block.startedAt && block.endedAt) {
    return `Thought for ${formatDuration(block.endedAt - block.startedAt)}`;
  }
  return 'Thinking…';
}

function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

/** Pick a glyph for a tool row from its name, native-extension style. */
function toolIcon(name: string): string {
  const n = name.toLowerCase();
  if (n === 'bash' || n.includes('terminal') || n.includes('shell')) return terminalIcon();
  if (n === 'read' || n === 'notebookread') return fileIcon();
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'notebookedit') return pencilIcon();
  if (n === 'grep' || n === 'glob' || n.includes('search')) return searchIcon();
  if (n === 'webfetch' || n === 'websearch' || n.includes('fetch')) return globeIcon();
  if (n === 'todowrite' || n.includes('todo')) return listIcon();
  if (n === 'task' || n.includes('agent')) return sparkleIcon();
  return fileIcon();
}

/**
 * A concise one-line argument summary for a tool row (the dimmed text after the
 * tool name), preferring the host-supplied title, else the most salient input.
 */
function toolSummary(tool: ToolUseView): string {
  if (tool.title) return tool.title;
  const inp = tool.input ?? {};
  // Prefer a human description (Bash) over the raw command, which is shown in the
  // IN/OUT panel; then fall back to the most salient argument.
  const pick =
    inp.description ?? inp.path ?? inp.file_path ?? inp.pattern ?? inp.query ?? inp.url ?? inp.command ?? inp.prompt;
  if (typeof pick === 'string') return pick.replace(/\s+/g, ' ').trim();
  return '';
}

/** IN / OUT terminal panel for Bash steps. */
function renderIO(command: string, output?: string): HTMLElement {
  const io = document.createElement('div');
  io.className = 'io';
  const inRow = document.createElement('div');
  inRow.className = 'io-row io-in';
  inRow.innerHTML = `<span class="io-label">IN</span><span class="io-text"></span>`;
  inRow.querySelector('.io-text')!.textContent = command;
  io.appendChild(inRow);
  if (output && output.trim()) {
    const outRow = document.createElement('div');
    outRow.className = 'io-row io-out';
    const truncated = output.length > 4000 ? output.slice(0, 4000) + '\n…' : output;
    outRow.innerHTML = `<span class="io-label">OUT</span><span class="io-text"></span>`;
    outRow.querySelector('.io-text')!.textContent = truncated;
    io.appendChild(outRow);
  }
  return io;
}

/** Muted subtitle under an edit step, e.g. "Added 8 lines". */
function diffSummary(diff: DiffView): string {
  const { additions, deletions } = diff;
  if (additions && !deletions) return `Added ${additions} ${plural(additions, 'line')}`;
  if (deletions && !additions) return `Removed ${deletions} ${plural(deletions, 'line')}`;
  if (additions || deletions) return `Added ${additions}, removed ${deletions} ${plural(additions + deletions, 'line')}`;
  return 'No changes';
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function statusIcon(status: ToolUseView['status']): string {
  switch (status) {
    case 'running':
    case 'pending':
      return '<span class="spinner" aria-label="running"></span>';
    case 'success':
      return `<span class="ok">${check()}</span>`;
    case 'error':
      return `<span class="err">${cross()}</span>`;
    case 'denied':
      return `<span class="denied">${denyIcon()}</span>`;
    default:
      return '';
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

/** Minimal CSS.escape fallback for attribute selectors. */
function cssEscape(s: string): string {
  return s.replace(/["\\\]]/g, '\\$&');
}
