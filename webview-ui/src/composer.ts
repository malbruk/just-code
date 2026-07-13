/**
 * The bottom input region, rebuilt to mirror the official Claude Code composer:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  [▣ image.png 718×581]  ← external attachments (pasted/uploaded) │
 *   │  textarea  (@-mentions live here, inline)                        │
 *   │  project attachments (editor context / "Add to chat")            │
 *   │  [+] [/]                              ⚡ Auto mode        [↑]     │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The left cluster carries two icon buttons — `+` (attach / context menu) and
 * `/` (a square-with-slash "actions & commands" menu). The model picker no
 * longer lives on the bar; "Switch model…" is inside the `/` menu. The
 * permission-mode picker sits on the right next to the send button, styled as a
 * bordered pill (⚡ for Auto mode), matching Claude Code. All menus open as a
 * shared lightweight popup anchored above their trigger.
 */
import type {
  Attachment,
  AuthMethod,
  CompletionItem,
  EffortLevel,
  ModelId,
  PermissionMode,
  RateLimitWarning,
  SlashCommand,
  UsageInfo,
} from '../../src/shared/protocol.js';
import { MODELS, EFFORT_LEVELS } from '../../src/shared/protocol.js';
import type { AppState } from './state.js';
import { escapeHtml } from './markdown.js';
import { imagesFromDataTransfer, toImageAttachment } from './image.js';
import {
  send as sendIcon,
  stop as stopIcon,
  close,
  plus,
  caretDown,
  check,
  slashSquare,
  bolt,
  hand,
  code,
  list,
  upload,
  file as fileIcon,
  folder as folderIcon,
  globe,
} from './icons.js';

/**
 * Permission modes, presented with Claude Code's labels/descriptions but mapped
 * onto the same four SDK `PermissionMode`s. Each carries a bar glyph.
 */
const PERMISSION_MODES: {
  id: PermissionMode;
  label: string;
  detail: string;
  icon: () => string;
}[] = [
  { id: 'default', label: 'Manual', detail: 'Claude will ask for approval before making each edit', icon: hand },
  { id: 'acceptEdits', label: 'Edit automatically', detail: 'Claude will edit your selected text or the whole file', icon: code },
  { id: 'plan', label: 'Plan mode', detail: 'Claude will explore the code and present a plan before editing', icon: list },
  { id: 'bypassPermissions', label: 'Auto mode', detail: 'Claude will approve actions that pass a safety check and pause for anything risky', icon: bolt },
];

/** Order used when cycling modes with Shift+Tab (matches Claude Code). */
const MODE_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** Rows the input grows to before it starts scrolling (matches Claude Code). */
const MAX_ROWS = 10;

/**
 * An `@path` mention in the prompt, and the trailing punctuation that is
 * sentence structure rather than part of the path. Both must stay in step with
 * the host's mention scanner (`SessionManager.mentionedFiles`), which decides
 * which of these the model actually receives file contents for.
 */
const MENTION_RE = /(?:^|\s)@([^\s@]+)/g;
const MENTION_TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

type MenuKind = 'model' | 'mode' | 'plus' | 'slash';

export interface ComposerCallbacks {
  onSubmit: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onRequestCompletions: (kind: 'slash' | 'file', query: string) => void;
  onRemoveAttachment: (index: number) => void;
  /** An image was pasted (or dropped) into the composer — pin it as a chip. */
  onAddImageAttachment: (attachment: Attachment) => void;
  /** Surface a problem with a pasted image (e.g. undecodable bytes). */
  onAttachmentError: (message: string) => void;
  onSetModel: (model: ModelId) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  /** Start a fresh conversation (used by the "Clear conversation" action). */
  onNewChat: () => void;
  onDraftChange: (text: string) => void;
  /** `+` → Upload from computer: open a native file picker on the host. */
  onUploadFromComputer: () => void;
  /** Change reasoning effort level. */
  onSetEffort: (effort: EffortLevel) => void;
  /** Toggle extended thinking. */
  onSetThinking: (enabled: boolean) => void;
  /** Toggle "switch models when a message is flagged" (fallback model). */
  onSetModelFallback: (enabled: boolean) => void;
  /** Rewind to the previous user turn. */
  onRewind: () => void;
  /** `/` → Account & usage…: open the account dialog. */
  onOpenAccount: () => void;
}

interface ActiveTrigger {
  kind: 'slash' | 'file';
  /** Index in the textarea value where the trigger char (`@`/`/`) sits. */
  start: number;
}

export class Composer {
  readonly root: HTMLElement;
  private readonly externalChipsEl: HTMLElement;
  private readonly projectChipsEl: HTMLElement;
  private readonly barDividerEl: HTMLElement;
  private readonly shellEl: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly highlightEl: HTMLElement;
  private readonly popup: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly plusBtn: HTMLButtonElement;
  private readonly slashBtn: HTMLButtonElement;
  private readonly modePill: HTMLButtonElement;
  private readonly usageEl: HTMLElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly limitBannerEl: HTMLElement;

  private busy = false;
  private attachments: Attachment[] = [];
  private slashCommands: SlashCommand[] = [];
  private model: ModelId = 'default';
  private permissionMode: PermissionMode = 'default';
  private trigger: ActiveTrigger | null = null;
  private completions: CompletionItem[] = [];
  private activeIndex = 0;
  private openMenuKind: MenuKind | null = null;
  private slashFilter = '';

  // Reasoning settings, mirrored from AppState (all SDK-backed).
  private effort: EffortLevel = 'default';
  private extendedThinking = true;
  private autoModelFallback = false;

  constructor(private readonly cb: ComposerCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'composer';
    // The limit banner sits outside `.input-shell` so it never disturbs the
    // menu positioning, which measures offsets against the shell.
    this.root.innerHTML = `
      <div class="limit-banner" hidden role="status"></div>
      <div class="input-shell">
        <div class="chips chips-external" role="list"></div>
        <div class="input-field">
          <div class="input-highlight" aria-hidden="true"></div>
          <textarea class="input" rows="1" placeholder="Ask Just Code…  (@ for files, / for commands)"></textarea>
        </div>
        <div class="completions" hidden></div>
        <div class="input-bar">
          <div class="input-bar-left">
            <button type="button" class="icon-btn plus-btn" title="Attach & context" aria-label="Attach & context">${plus()}</button>
            <button type="button" class="icon-btn slash-btn" title="Actions & commands" aria-label="Actions & commands">${slashSquare()}</button>
            <span class="bar-divider" hidden></span>
            <div class="chips chips-project" role="list"></div>
          </div>
          <div class="input-bar-right">
            <span class="usage" hidden></span>
            <button type="button" class="pill mode-pill" title="Permission mode (Shift+Tab to cycle)">
              <span class="pill-icon"></span><span class="pill-label"></span>${caretDown()}
            </button>
            <button type="button" class="send-btn" title="Send">${sendIcon()}</button>
          </div>
        </div>
        <div class="menu" hidden></div>
      </div>`;

    this.externalChipsEl = this.q('.chips-external');
    this.projectChipsEl = this.q('.chips-project');
    this.barDividerEl = this.q('.bar-divider');
    this.shellEl = this.q('.input-shell');
    this.textarea = this.q('.input');
    this.highlightEl = this.q('.input-highlight');
    this.popup = this.q('.completions');
    this.menu = this.q('.menu');
    this.plusBtn = this.q('.plus-btn');
    this.slashBtn = this.q('.slash-btn');
    this.modePill = this.q('.mode-pill');
    this.usageEl = this.q('.usage');
    this.sendBtn = this.q('.send-btn');
    this.limitBannerEl = this.q('.limit-banner');

    this.wire();
    this.renderModePill();
  }

  private q<T extends HTMLElement>(sel: string): T {
    const el = this.root.querySelector<T>(sel);
    if (!el) throw new Error(`missing element ${sel}`);
    return el;
  }

  private wire(): void {
    this.textarea.addEventListener('input', () => {
      this.autoGrow();
      this.cb.onDraftChange(this.textarea.value);
      this.detectTrigger();
    });

    this.textarea.addEventListener('keydown', (e) => this.onKeydown(e));
    this.textarea.addEventListener('paste', (e) => void this.onPaste(e));
    // Keep the mention chips glued to their words once the field scrolls.
    this.textarea.addEventListener('scroll', () => {
      this.highlightEl.scrollTop = this.textarea.scrollTop;
    });

    this.sendBtn.addEventListener('click', () => {
      if (this.busy) this.cb.onStop();
      else this.submit();
    });

    this.plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMenu('plus');
    });
    this.slashBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMenu('slash');
    });
    this.modePill.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMenu('mode');
    });

    this.limitBannerEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-action="account"]')) this.cb.onOpenAccount();
    });

    this.menu.addEventListener('click', (e) => this.onMenuClick(e));
    this.menu.addEventListener('input', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('menu-filter-input')) {
        this.slashFilter = (target as HTMLInputElement).value;
        this.renderSlashList();
      }
    });

    // Close the picker menu on any outside interaction.
    document.addEventListener('mousedown', (e) => {
      if (!this.openMenuKind) return;
      const t = e.target as HTMLElement;
      if (
        this.menu.contains(t) ||
        this.plusBtn.contains(t) ||
        this.slashBtn.contains(t) ||
        this.modePill.contains(t)
      )
        return;
      this.closeMenu();
    });

    const chipClick = (e: Event) => {
      const btn = (e.target as HTMLElement).closest('[data-remove-chip]');
      if (btn) this.cb.onRemoveAttachment(Number(btn.getAttribute('data-remove-chip')));
    };
    this.externalChipsEl.addEventListener('click', chipClick);
    this.projectChipsEl.addEventListener('click', chipClick);

    this.popup.addEventListener('mousedown', (e) => {
      // mousedown so it fires before the textarea blur.
      const item = (e.target as HTMLElement).closest('[data-completion]');
      if (item) {
        e.preventDefault();
        this.chooseCompletion(Number(item.getAttribute('data-completion')));
      }
    });
  }

  // -- public API used by main ---------------------------------------------

  update(state: AppState): void {
    this.busy = state.busy;
    this.attachments = state.attachments;
    this.slashCommands = state.slashCommands;
    this.model = state.model;
    this.permissionMode = state.permissionMode;
    this.effort = state.effort;
    this.extendedThinking = state.extendedThinking;
    this.autoModelFallback = state.autoModelFallback;
    this.root.classList.toggle('mode-plan', state.permissionMode === 'plan');
    this.renderModePill();
    this.renderChips();
    this.renderUsage(state.usage, state.authMethod);
    this.renderLimitBanner(state.rateLimitWarning);
    this.renderSendButton();
  }

  /**
   * The plan-limit notice above the input. Clicking it opens the account dialog,
   * which is where the user can actually see and act on the numbers.
   */
  private renderLimitBanner(warning: RateLimitWarning | undefined): void {
    if (!warning) {
      this.limitBannerEl.hidden = true;
      this.limitBannerEl.innerHTML = '';
      return;
    }
    this.limitBannerEl.hidden = false;
    this.limitBannerEl.className = `limit-banner limit-${warning.severity}`;
    this.limitBannerEl.innerHTML =
      `<span class="limit-text">${escapeHtml(warning.message)}</span>` +
      `<button type="button" class="limit-link" data-action="account">View usage</button>`;
  }

  setDraft(text: string): void {
    this.textarea.value = text;
    this.autoGrow();
  }

  focus(): void {
    this.textarea.focus();
  }

  fill(text: string): void {
    this.textarea.value = text;
    this.autoGrow();
    this.focus();
    this.cb.onDraftChange(text);
  }

  showCompletions(kind: 'slash' | 'file', items: CompletionItem[]): void {
    if (!this.trigger || this.trigger.kind !== kind) return;
    this.completions = items;
    this.activeIndex = 0;
    this.renderPopup();
  }

  // -- mode pill ------------------------------------------------------------

  private renderModePill(): void {
    const mode = PERMISSION_MODES.find((m) => m.id === this.permissionMode) ?? PERMISSION_MODES[0];
    this.q<HTMLElement>('.mode-pill .pill-icon').innerHTML = mode.icon();
    this.q<HTMLElement>('.mode-pill .pill-label').textContent = mode.label;
    this.modePill.setAttribute('data-mode', this.permissionMode);
    this.modePill.classList.toggle('mode-plan', this.permissionMode === 'plan');
  }

  // -- menus ----------------------------------------------------------------

  private toggleMenu(kind: MenuKind): void {
    if (this.openMenuKind === kind) {
      this.closeMenu();
      return;
    }
    this.closePopup();
    this.openMenuKind = kind;
    if (kind === 'slash') this.slashFilter = '';
    this.menu.className = `menu menu-${kind}`;
    this.menu.innerHTML = this.buildMenu(kind);
    this.menu.hidden = false;
    this.positionMenu(kind);
    this.reflectTriggerState();
    if (kind === 'slash') {
      this.renderSlashList();
      const input = this.menu.querySelector<HTMLInputElement>('.menu-filter-input');
      if (input) setTimeout(() => input.focus(), 0);
    }
  }

  /** Open a menu, replacing whatever is open (used for slash → model chaining). */
  private openMenu(kind: MenuKind): void {
    this.openMenuKind = null;
    this.toggleMenu(kind);
  }

  private reflectTriggerState(): void {
    this.plusBtn.classList.toggle('open', this.openMenuKind === 'plus');
    this.slashBtn.classList.toggle('open', this.openMenuKind === 'slash' || this.openMenuKind === 'model');
    this.modePill.classList.toggle('open', this.openMenuKind === 'mode');
  }

  private closeMenu(): void {
    this.openMenuKind = null;
    this.menu.hidden = true;
    this.reflectTriggerState();
  }

  private anchorFor(kind: MenuKind): HTMLElement {
    if (kind === 'mode') return this.modePill;
    if (kind === 'plus') return this.plusBtn;
    return this.slashBtn; // slash + model both hang off the `/` button
  }

  private positionMenu(kind: MenuKind): void {
    const anchor = this.anchorFor(kind);
    const gap = 6;
    this.menu.style.bottom = `${this.shellEl.clientHeight - anchor.offsetTop + gap}px`;
    if (kind === 'mode') {
      // Right-align the mode menu to the pill's right edge.
      this.menu.style.left = 'auto';
      this.menu.style.right = `${this.shellEl.clientWidth - (anchor.offsetLeft + anchor.offsetWidth)}px`;
    } else {
      this.menu.style.right = 'auto';
      this.menu.style.left = `${anchor.offsetLeft}px`;
    }
  }

  private buildMenu(kind: MenuKind): string {
    switch (kind) {
      case 'mode':
        return this.buildModeMenu();
      case 'model':
        return this.buildModelMenu();
      case 'plus':
        return this.buildPlusMenu();
      case 'slash':
        return this.buildSlashMenu();
    }
  }

  private actionItem(action: string, icon: string | null, label: string, detail?: string, trailing?: string): string {
    return (
      `<div class="menu-item" data-action="${action}" role="menuitem">` +
      (icon !== null ? `<span class="menu-ico">${icon}</span>` : '') +
      `<span class="menu-text"><span class="menu-label">${escapeHtml(label)}</span>` +
      (detail ? `<span class="menu-detail">${escapeHtml(detail)}</span>` : '') +
      `</span>` +
      (trailing ? `<span class="menu-trailing">${trailing}</span>` : '') +
      `</div>`
    );
  }

  private toggleRow(id: string, label: string, on: boolean): string {
    return (
      `<div class="menu-item menu-row" data-toggle="${id}" role="menuitemcheckbox" aria-checked="${on}">` +
      `<span class="menu-text"><span class="menu-label">${escapeHtml(label)}</span></span>` +
      `<span class="switch${on ? ' on' : ''}" aria-hidden="true"><span class="switch-knob"></span></span>` +
      `</div>`
    );
  }

  /** Effort selector — a clickable 5-level control bound to SDK `Options.effort`. */
  private effortRow(): string {
    // `default` means "leave the model default (high)"; highlight through `high`.
    const current = this.effort === 'default' ? 'high' : this.effort;
    const activeIdx = EFFORT_LEVELS.indexOf(current as (typeof EFFORT_LEVELS)[number]);
    const label = current.charAt(0).toUpperCase() + current.slice(1);
    const dots = EFFORT_LEVELS.map(
      (lvl, i) =>
        `<button type="button" class="effort-dot${i <= activeIdx ? ' on' : ''}" data-effort="${lvl}" ` +
        `title="${lvl}" aria-label="Effort: ${lvl}"></button>`,
    ).join('');
    return (
      `<div class="menu-item menu-row menu-effort" role="group">` +
      `<span class="menu-label">Effort <span class="menu-dim">(${escapeHtml(label)})</span></span>` +
      `<span class="effort">${dots}</span></div>`
    );
  }

  private buildModeMenu(): string {
    const items = PERMISSION_MODES.map((m) => {
      const active = m.id === this.permissionMode;
      return (
        `<div class="menu-item${active ? ' active' : ''}" data-value="${m.id}" role="menuitemradio" aria-checked="${active}">` +
        `<span class="menu-check">${active ? check() : ''}</span>` +
        `<span class="menu-text"><span class="menu-label">${escapeHtml(m.label)}</span>` +
        `<span class="menu-detail">${escapeHtml(m.detail)}</span></span></div>`
      );
    }).join('');
    return (
      `<div class="menu-head"><span class="menu-head-title">Modes</span>` +
      `<span class="menu-head-hint">⇧+tab to switch</span></div>` +
      items +
      `<div class="menu-sep"></div>` +
      this.effortRow()
    );
  }

  private buildModelMenu(): string {
    const items = MODELS.map((m) => {
      const active = m.id === this.model;
      return (
        `<div class="menu-item${active ? ' active' : ''}" data-value="${m.id}" role="menuitemradio" aria-checked="${active}">` +
        `<span class="menu-check">${active ? check() : ''}</span>` +
        `<span class="menu-text"><span class="menu-label">${escapeHtml(m.label)}</span>` +
        `<span class="menu-detail">${escapeHtml(m.description)}</span></span></div>`
      );
    }).join('');
    return `<div class="menu-head"><span class="menu-head-title">Switch model</span></div>` + items;
  }

  private buildPlusMenu(): string {
    return (
      this.actionItem('upload', upload(), 'Upload from computer', 'Attach an image or file from your machine') +
      this.actionItem('addContext', fileIcon(), 'Add context', 'Mention a file from this project') +
      this.actionItem('browseWeb', globe(), 'Browse the web', 'Let Claude look something up online')
    );
  }

  private buildSlashMenu(): string {
    const modelLabel = MODELS.find((m) => m.id === this.model)?.label ?? 'Default';
    return (
      `<div class="menu-filter"><input type="text" class="menu-filter-input" placeholder="Filter actions…" autocomplete="off" spellcheck="false" /></div>` +
      `<div class="menu-scroll">` +
      `<div class="menu-section">Context</div>` +
      this.actionItem('upload', null, 'Attach file…') +
      this.actionItem('mentionFile', null, 'Mention file from this project…') +
      this.actionItem('clear', null, 'Clear conversation') +
      this.actionItem('rewind', null, 'Rewind') +
      `<div class="menu-section">Model</div>` +
      this.actionItem('switchModel', null, 'Switch model…', undefined, `<span class="menu-dim">${escapeHtml(modelLabel)}</span>`) +
      this.effortRow() +
      this.toggleRow('thinking', 'Thinking', this.extendedThinking) +
      this.toggleRow('flagged', 'Switch models when a message is flagged', this.autoModelFallback) +
      this.actionItem('account', null, 'Account & usage…') +
      `<div class="menu-section">Commands</div>` +
      `<div class="menu-commands"></div>` +
      `</div>`
    );
  }

  /** (Re)render just the filtered command list inside the open slash menu. */
  private renderSlashList(): void {
    const wrap = this.menu.querySelector<HTMLElement>('.menu-commands');
    if (!wrap) return;
    const q = this.slashFilter.trim().toLowerCase().replace(/^\//, '');
    const filtered = this.slashCommands.filter(
      (c) => c.name.slice(1).toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
    if (!filtered.length) {
      wrap.innerHTML = `<div class="menu-empty">No matching commands</div>`;
      return;
    }
    wrap.innerHTML = filtered
      .map(
        (c) =>
          `<div class="menu-item" data-command="${escapeHtml(c.name)}" role="menuitem">` +
          `<span class="menu-text"><span class="menu-label menu-cmd">${escapeHtml(c.name)}` +
          (c.argHint ? ` <span class="menu-dim">${escapeHtml(c.argHint)}</span>` : '') +
          `</span><span class="menu-detail">${escapeHtml(c.description)}</span></span></div>`,
      )
      .join('');
  }

  private onMenuClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('.menu-filter')) return;

    // Effort dots: set the level (keep the menu open, re-render the row).
    const effortDot = target.closest('[data-effort]');
    if (effortDot) {
      this.effort = effortDot.getAttribute('data-effort') as EffortLevel;
      this.cb.onSetEffort(this.effort);
      const row = effortDot.closest('.menu-effort');
      if (row) row.outerHTML = this.effortRow();
      return;
    }
    if (target.closest('.menu-effort')) return;

    const toggle = target.closest('[data-toggle]');
    if (toggle) {
      const id = toggle.getAttribute('data-toggle');
      const sw = toggle.querySelector('.switch');
      sw?.classList.toggle('on');
      const on = Boolean(sw?.classList.contains('on'));
      toggle.setAttribute('aria-checked', String(on));
      if (id === 'thinking') {
        this.extendedThinking = on;
        this.cb.onSetThinking(on);
      } else if (id === 'flagged') {
        this.autoModelFallback = on;
        this.cb.onSetModelFallback(on);
      }
      return; // keep the menu open for toggles
    }

    const valueEl = target.closest('[data-value]');
    if (valueEl) {
      const value = valueEl.getAttribute('data-value') ?? '';
      if (this.openMenuKind === 'model') this.selectModel(value as ModelId);
      else if (this.openMenuKind === 'mode') this.selectMode(value as PermissionMode);
      this.closeMenu();
      return;
    }

    const cmdEl = target.closest('[data-command]');
    if (cmdEl) {
      this.closeMenu();
      this.fill(`${cmdEl.getAttribute('data-command')} `);
      return;
    }

    const actionEl = target.closest('[data-action]');
    if (actionEl) {
      this.runAction(actionEl.getAttribute('data-action') ?? '');
    }
  }

  private runAction(action: string): void {
    switch (action) {
      case 'upload':
        this.closeMenu();
        this.cb.onUploadFromComputer();
        break;
      case 'addContext':
        // Insert `@` and open the project file list to pick context, mirroring
        // Claude Code's "Add context" flow.
        this.closeMenu();
        this.insertAtCaret('@');
        break;
      case 'browseWeb':
        // WebSearch/WebFetch ship in the claude_code tool preset, so the model
        // can already browse — seed a scaffold so the request routes to them.
        this.closeMenu();
        this.fill('Search the web for ');
        break;
      case 'mentionFile':
        this.closeMenu();
        this.insertAtCaret('@');
        break;
      case 'clear':
        this.closeMenu();
        this.cb.onNewChat();
        break;
      case 'switchModel':
        this.openMenu('model');
        break;
      case 'account':
        this.closeMenu();
        this.cb.onOpenAccount();
        break;
      case 'rewind':
        this.closeMenu();
        this.cb.onRewind();
        break;
      default:
        this.closeMenu();
        break;
    }
  }

  private selectModel(model: ModelId): void {
    this.model = model;
    this.cb.onSetModel(model);
  }

  private selectMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.root.classList.toggle('mode-plan', mode === 'plan');
    this.renderModePill();
    this.cb.onSetPermissionMode(mode);
  }

  private cycleMode(): void {
    const idx = MODE_CYCLE.indexOf(this.permissionMode);
    const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    this.selectMode(next);
  }

  /** Insert text at the caret, then re-run trigger detection (for `@`/`/`). */
  private insertAtCaret(text: string): void {
    const value = this.textarea.value;
    const caret = this.textarea.selectionStart ?? value.length;
    const needsSpace = caret > 0 && !/\s/.test(value[caret - 1] ?? '');
    const insert = (needsSpace ? ' ' : '') + text;
    this.textarea.value = value.slice(0, caret) + insert + value.slice(caret);
    const pos = caret + insert.length;
    this.textarea.setSelectionRange(pos, pos);
    this.autoGrow();
    this.focus();
    this.cb.onDraftChange(this.textarea.value);
    this.detectTrigger();
  }

  // -- paste ----------------------------------------------------------------

  /**
   * Attach images pasted straight from the clipboard — the screenshot flow,
   * where nothing was ever saved to disk.
   *
   * A rich-text copy (from a browser, Word, Excel…) usually puts *both* a
   * bitmap and plain text on the clipboard. Text wins there, so ordinary
   * pasting is never hijacked; we only take over when there is no text.
   */
  private async onPaste(e: ClipboardEvent): Promise<void> {
    const dt = e.clipboardData;
    if (!dt || dt.getData('text/plain')) return;
    const files = imagesFromDataTransfer(dt);
    if (!files.length) return;
    e.preventDefault();

    for (const file of files) {
      // `this.attachments` is refreshed by `update()` after each add, so labels
      // stay unique across a multi-image paste.
      const attachment = await toImageAttachment(file, this.attachments);
      if (attachment) this.cb.onAddImageAttachment(attachment);
      else this.cb.onAttachmentError(`Could not read the pasted image (${file.type || 'unknown type'}).`);
    }
  }

  // -- internals -----------------------------------------------------------

  private renderSendButton(): void {
    this.sendBtn.classList.toggle('is-stop', this.busy);
    this.sendBtn.title = this.busy ? 'Stop' : 'Send';
    this.sendBtn.innerHTML = this.busy ? stopIcon() : sendIcon();
  }

  private renderChips(): void {
    const external: string[] = [];
    const project: string[] = [];
    this.attachments.forEach((a, i) => {
      const html = this.chipHtml(a, i);
      (a.external ? external : project).push(html);
    });
    this.externalChipsEl.innerHTML = external.join('');
    this.externalChipsEl.style.display = external.length ? '' : 'none';
    this.projectChipsEl.innerHTML = project.join('');
    this.projectChipsEl.style.display = project.length ? '' : 'none';
    // The vertical divider only shows when project chips sit next to the buttons.
    this.barDividerEl.hidden = project.length === 0;
  }

  /**
   * External attachments render as cards inside the top of the input frame
   * (thumbnail + name + pixel size); project attachments stay as compact pills
   * on the button row. Both share the chip skeleton.
   */
  private chipHtml(a: Attachment, i: number): string {
    const cls =
      `chip chip-${a.kind}` +
      (a.ephemeral ? ' chip-ephemeral' : '') +
      (a.external ? ' chip-card' : '');
    const hint = a.ephemeral ? '<span class="chip-hint" title="Active editor — auto-included">active</span>' : '';
    const lead =
      a.kind === 'image' && a.dataUri
        ? `<img class="chip-thumb" src="${escapeHtml(a.dataUri)}" alt="" />`
        : a.external
          ? `<span class="chip-ico">${fileIcon()}</span>`
          : '';
    const dims =
      a.width && a.height ? `<span class="chip-dims">${a.width}×${a.height}</span>` : '';
    return (
      `<span class="${cls}" role="listitem" title="${escapeHtml(a.path ?? a.label)}">${lead}` +
      `<span class="chip-label">${escapeHtml(a.label)}</span>${dims}${hint}` +
      `<button type="button" class="chip-x" data-remove-chip="${i}" title="Remove">${close()}</button></span>`
    );
  }

  private renderUsage(usage?: UsageInfo, authMethod?: AuthMethod): void {
    if (!usage) {
      this.usageEl.hidden = true;
      return;
    }
    this.usageEl.hidden = false;
    const parts: string[] = [];
    const tips: string[] = [];
    const total = usage.inputTokens + usage.outputTokens;
    if (total) {
      parts.push(`${formatTokens(total)} tok`);
      tips.push(`New tokens this turn (input + output): ${total.toLocaleString()}`);
    }
    // A dollar figure is misleading on a subscription — the user isn't billed
    // per-API-cost. Only show it when authenticating with a Console API key.
    if (typeof usage.costUsd === 'number' && authMethod !== 'subscription') {
      parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 1 ? 3 : 2)}`);
    }
    if (usage.contextTokens && usage.contextWindow) {
      const pct = Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100));
      parts.push(`${pct}% ctx`);
      tips.push(
        `Context window: ${usage.contextTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens` +
          ` (includes cached system prompt, tools, CLAUDE.md & history)`,
      );
    }
    this.usageEl.textContent = parts.join('  ·  ');
    this.usageEl.title = tips.length ? tips.join('\n') : 'Session usage';
  }

  /**
   * Paint the `@path` mentions in the input as chips. A `<textarea>` can't hold
   * styled spans, so an aria-hidden mirror sits directly behind it with the same
   * text, same metrics and transparent glyphs — only its mention backgrounds
   * show through, under the real (opaque) textarea text. Keep the two in sync:
   * any change to `.input`'s font, padding or line-height must be mirrored on
   * `.input-highlight`, or the chips will drift off their words.
   */
  private renderHighlight(): void {
    const text = this.textarea.value;
    let html = '';
    let cursor = 0;
    for (const m of text.matchAll(MENTION_RE)) {
      // `m[0]` may lead with the whitespace the pattern required; the `@` sits
      // right before the captured path. Trailing punctuation ends the sentence,
      // not the path, so it stays outside the chip — as the host reads it.
      const mention = m[1].replace(MENTION_TRAILING_PUNCT, '');
      if (!mention) continue;
      const at = (m.index ?? 0) + m[0].length - m[1].length - 1;
      const end = at + mention.length + 1;
      html += escapeHtml(text.slice(cursor, at));
      html += `<span class="mention">${escapeHtml(text.slice(at, end))}</span>`;
      cursor = end;
    }
    html += escapeHtml(text.slice(cursor));
    // `pre-wrap` swallows a trailing newline; the textarea shows the blank line.
    this.highlightEl.innerHTML = text.endsWith('\n') ? `${html} ` : html;
    this.highlightEl.scrollTop = this.textarea.scrollTop;
  }

  /** Grow the field upward with its content, up to MAX_ROWS; scroll past that. */
  private autoGrow(): void {
    this.renderHighlight();
    const cs = getComputedStyle(this.textarea);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const max = Math.round(lineHeight * MAX_ROWS + padding);

    // Collapse first so scrollHeight reports the content height, not the old box.
    this.textarea.style.height = 'auto';
    const content = this.textarea.scrollHeight;
    this.textarea.style.height = `${Math.min(content, max)}px`;
    this.textarea.style.overflowY = content > max ? 'auto' : 'hidden';
    // Once a scrollbar appears the textarea's text column narrows; match it so
    // lines wrap at the same column in both layers.
    this.highlightEl.style.width = `${this.textarea.clientWidth}px`;
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!this.popup.hidden && this.completions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.activeIndex = (this.activeIndex + 1) % this.completions.length;
        this.renderPopup();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.activeIndex = (this.activeIndex - 1 + this.completions.length) % this.completions.length;
        this.renderPopup();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.chooseCompletion(this.activeIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closePopup();
        return;
      }
    }

    // Shift+Tab cycles the permission mode, mirroring Claude Code.
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      this.cycleMode();
      return;
    }

    if (e.key === 'Escape' && this.openMenuKind) {
      e.preventDefault();
      this.closeMenu();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!this.busy) this.submit();
    }
  }

  private submit(): void {
    const text = this.textarea.value.trim();
    // An image on its own is a complete prompt ("what's wrong with this?"), but
    // the always-present editor-context chip must not make an empty box sendable.
    if (!text && !this.attachments.some((a) => a.kind === 'image')) return;
    this.cb.onSubmit(text, this.attachments.slice());
    this.textarea.value = '';
    this.autoGrow();
    this.closePopup();
    this.cb.onDraftChange('');
  }

  private detectTrigger(): void {
    const value = this.textarea.value;
    const caret = this.textarea.selectionStart ?? value.length;
    const upto = value.slice(0, caret);

    // Slash command: only when it's the very start of the input. Spaces are
    // allowed in the query so multi-word aliases ("switch model") can be typed;
    // the host drops the match once a real argument starts, which closes this.
    const slash = upto.match(/^\/([^\n]*)$/);
    if (slash) {
      this.trigger = { kind: 'slash', start: 0 };
      this.cb.onRequestCompletions('slash', slash[1]);
      return;
    }

    // File mention: an `@` preceded by start-or-whitespace, up to the caret.
    const at = upto.match(/(?:^|\s)@([^\s@]*)$/);
    if (at) {
      const start = caret - at[1].length - 1;
      this.trigger = { kind: 'file', start };
      this.cb.onRequestCompletions('file', at[1]);
      return;
    }

    this.closePopup();
  }

  private renderPopup(): void {
    if (!this.completions.length) {
      this.closePopup();
      return;
    }
    this.popup.hidden = false;
    this.popup.innerHTML = this.completions
      .map((c, i) => {
        const icon = c.kind === 'directory' ? folderIcon() : c.kind === 'file' ? fileIcon() : '';
        return (
          `<div class="completion${i === this.activeIndex ? ' active' : ''}" data-completion="${i}">` +
          (icon ? `<span class="completion-ico">${icon}</span>` : '') +
          `<span class="completion-label">${escapeHtml(c.label)}</span>` +
          (c.detail ? `<span class="completion-detail">${escapeHtml(c.detail)}</span>` : '') +
          `</div>`
        );
      })
      .join('');
    const active = this.popup.querySelector('.completion.active');
    active?.scrollIntoView({ block: 'nearest' });
  }

  private closePopup(): void {
    this.popup.hidden = true;
    this.completions = [];
    this.trigger = null;
  }

  /**
   * Replace the `@…`/`/…` the user was typing with the chosen item's insert
   * text. An `@`-mention stays *inline in the prompt* (the host reads the file
   * and splices its contents in on submit) rather than becoming a chip — that
   * is what Claude Code does; it is painted as a chip by `renderHighlight`.
   *
   * Choosing a folder is not a completion but a navigation step: the query
   * becomes `dir/` and the popup stays open, now listing what's inside.
   */
  private chooseCompletion(index: number): void {
    const item = this.completions[index];
    if (!item || !this.trigger) return;

    // The model command opens the inline model picker directly — mirroring the
    // "Switch model…" action in the slash-button menu — instead of leaving
    // `/model ` in the box for the user to submit.
    if (this.trigger.kind === 'slash' && item.kind === 'command' && item.insert.trim() === '/model') {
      this.textarea.value = '';
      this.autoGrow();
      this.closePopup();
      this.cb.onDraftChange('');
      this.openMenu('model');
      return;
    }

    const value = this.textarea.value;
    const caret = this.textarea.selectionStart ?? value.length;
    const before = value.slice(0, this.trigger.start);
    const after = value.slice(caret);

    this.textarea.value = before + item.insert + after;
    const pos = before.length + item.insert.length;
    this.textarea.setSelectionRange(pos, pos);
    if (item.kind === 'directory') this.detectTrigger();
    else this.closePopup();
    this.autoGrow();
    this.focus();
    this.cb.onDraftChange(this.textarea.value);
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
