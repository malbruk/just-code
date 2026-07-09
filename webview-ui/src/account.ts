/**
 * The "Account & usage" dialog, opened from the `/` menu.
 *
 * Mirrors Claude Code's `/usage` view: who you're signed in as, a meter per
 * plan rate-limit window, and — for claude.ai subscribers — a breakdown of what
 * has been driving that usage, scanned from local transcripts on this machine.
 *
 * The host owns the data (`requestAccountUsage` → `accountUsage`); this module
 * owns only presentation and the Day/Week toggle.
 */
import type { AccountUsage, UsageBreakdown, UsageContributor } from '../../src/shared/protocol.js';
import { MANAGE_USAGE_URL } from '../../src/shared/protocol.js';
import { escapeHtml } from './markdown.js';
import { close as closeIcon } from './icons.js';

export interface AccountDialogCallbacks {
  /** Ask the host for fresh data (the dialog opens on a spinner). */
  onRequest: () => void;
  /** Open an external URL through the host — the webview can't navigate. */
  onOpenUrl: (url: string) => void;
}

/** Which breakdown window the toggle is showing. */
type Span = 'day' | 'week';

/** Human label for the auth method, matching the screenshot's "Claude AI". */
function authMethodLabel(usage: AccountUsage): string {
  if (usage.auth.method === 'apiKey') return 'API key';
  return 'Claude AI';
}

/** "Claude pro" / "Claude max" from the raw `pro` / `max` tier. */
function planLabel(plan: string | undefined): string | undefined {
  if (!plan) return undefined;
  return `Claude ${plan}`;
}

/** Compact time-until, e.g. "3h", "5d", "12m" — the meter's "Resets in …" hint. */
function resetsIn(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return undefined;
  const ms = at - Date.now();
  if (ms <= 0) return undefined;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

function row(label: string, value: string): string {
  return (
    `<div class="acct-row"><span class="acct-row-label">${escapeHtml(label)}</span>` +
    `<span class="acct-row-value">${escapeHtml(value)}</span></div>`
  );
}

/**
 * One usage meter. The bar carries a severity class once it gets close to the
 * limit so the colour matches the composer banner.
 */
function meter(label: string, pct: number, resets: string | undefined): string {
  const severity = pct >= 100 ? ' is-full' : pct >= 70 ? ' is-high' : '';
  return (
    `<div class="acct-meter">` +
    `<div class="acct-meter-head">` +
    `<span class="acct-meter-label">${escapeHtml(label)}</span>` +
    `<span class="acct-meter-pct">${pct}%</span>` +
    `</div>` +
    `<div class="acct-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeHtml(label)}">` +
    `<span class="acct-bar-fill${severity}" style="width:${pct}%"></span>` +
    `</div>` +
    (resets ? `<div class="acct-meter-sub">Resets in ${escapeHtml(resets)}</div>` : '') +
    `</div>`
  );
}

/** A ranked contributor table (skills / agents / plugins / MCP servers). */
function contributors(title: string, rows: UsageContributor[], prefix = ''): string {
  if (!rows.length) return '';
  const items = rows
    .map(
      (r) =>
        `<div class="acct-contrib-row"><span class="acct-contrib-name">${escapeHtml(prefix + r.name)}</span>` +
        `<span class="acct-contrib-pct">${r.pct}%</span></div>`,
    )
    .join('');
  return (
    `<div class="acct-contrib">` +
    `<div class="acct-contrib-head"><span>${escapeHtml(title)}</span><span class="acct-dim">% of usage</span></div>` +
    items +
    `</div>`
  );
}

function breakdownBody(b: UsageBreakdown, span: Span): string {
  const window = span === 'day' ? 'Last 24h' : 'Last 7 days';
  const note =
    `<div class="acct-note">${escapeHtml(window)} · these are independent characteristics of your usage, ` +
    `not a breakdown</div>`;

  if (!b.behaviors.length && !b.skills.length && !b.agents.length && !b.plugins.length && !b.mcpServers.length) {
    return note + `<div class="acct-empty">Nothing notable in this window.</div>`;
  }

  const behaviors = b.behaviors
    .map(
      (x) =>
        `<div class="acct-behavior">` +
        `<div class="acct-behavior-headline">${escapeHtml(x.headline)}</div>` +
        `<div class="acct-behavior-body">${escapeHtml(x.body)}</div>` +
        `</div>`,
    )
    .join('');

  return (
    note +
    behaviors +
    contributors('Skills', b.skills, '/') +
    contributors('Agents', b.agents) +
    contributors('Plugins', b.plugins) +
    contributors('MCP servers', b.mcpServers)
  );
}

export class AccountDialog {
  readonly root: HTMLElement;
  private usage: AccountUsage | undefined;
  private span: Span = 'day';

  constructor(private readonly cb: AccountDialogCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'acct-overlay';
    this.root.hidden = true;

    this.root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // The transparent backdrop dismisses; clicks inside the panel do not.
      if (target === this.root || target.closest('[data-acct="close"]')) {
        this.close();
        return;
      }
      const span = target.closest('[data-span]');
      if (span) {
        this.span = span.getAttribute('data-span') as Span;
        this.render();
        return;
      }
      if (target.closest('[data-acct="manage"]')) {
        this.cb.onOpenUrl(MANAGE_USAGE_URL);
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Open on a spinner and ask the host to fill it in. */
  open(): void {
    this.usage = undefined;
    this.root.hidden = false;
    this.render();
    this.cb.onRequest();
  }

  close(): void {
    this.root.hidden = true;
  }

  show(usage: AccountUsage): void {
    this.usage = usage;
    if (!this.root.hidden) this.render();
  }

  showError(message: string): void {
    if (this.root.hidden) return;
    this.root.innerHTML = this.panel(
      `<div class="acct-error">${escapeHtml(message)}</div>`,
    );
  }

  private panel(body: string): string {
    return (
      `<div class="acct-panel" role="dialog" aria-modal="true" aria-label="Account and usage">` +
      `<div class="acct-header">` +
      `<span class="acct-title">Account &amp; Usage</span>` +
      `<button type="button" class="acct-close" data-acct="close" title="Close" aria-label="Close">${closeIcon()}</button>` +
      `</div>` +
      `<div class="acct-body">${body}</div>` +
      `</div>`
    );
  }

  private render(): void {
    if (!this.usage) {
      this.root.innerHTML = this.panel(
        `<div class="acct-loading"><span class="spinner"></span><span>Loading account…</span></div>`,
      );
      return;
    }
    const u = this.usage;

    // -- Account
    const rows: string[] = [row('Auth method', authMethodLabel(u))];
    if (u.auth.email) rows.push(row('Email', u.auth.email));
    if (u.auth.org) rows.push(row('Organization', u.auth.org));
    const plan = planLabel(u.auth.plan);
    if (plan) rows.push(row('Plan', plan));

    let body =
      `<div class="acct-section">ACCOUNT</div>` + `<div class="acct-rows">${rows.join('')}</div>`;

    // -- Usage
    body += `<div class="acct-section">USAGE</div>`;
    if (!u.limitsAvailable) {
      body +=
        `<div class="acct-empty">` +
        (u.auth.method === 'apiKey'
          ? 'API-key sessions bill per token and have no plan limits to report.'
          : 'Plan limits are not available for this account.') +
        `</div>`;
    } else if (!u.windows.length) {
      body += `<div class="acct-empty">No plan limit windows reported.</div>`;
    } else {
      body += u.windows.map((w) => meter(w.label, w.utilization, resetsIn(w.resetsAt))).join('');
    }

    if (typeof u.sessionCostUsd === 'number' && u.sessionCostUsd > 0) {
      body += `<div class="acct-cost">This session: $${u.sessionCostUsd.toFixed(u.sessionCostUsd < 1 ? 3 : 2)}</div>`;
    }

    body += `<button type="button" class="acct-manage" data-acct="manage">Manage usage on claude.ai</button>`;

    // -- What's contributing
    if (u.breakdown) {
      const b = this.span === 'day' ? u.breakdown.day : u.breakdown.week;
      body +=
        `<div class="acct-section">WHAT'S CONTRIBUTING TO YOUR LIMITS USAGE?</div>` +
        `<div class="acct-toggle" role="group" aria-label="Breakdown window">` +
        `<button type="button" class="acct-toggle-btn${this.span === 'day' ? ' active' : ''}" data-span="day">Day</button>` +
        `<button type="button" class="acct-toggle-btn${this.span === 'week' ? ' active' : ''}" data-span="week">Week</button>` +
        `</div>` +
        `<div class="acct-note acct-dim">Approximate, based on local sessions on this machine — does not include other ` +
        `devices or claude.ai</div>` +
        breakdownBody(b, this.span);
    }

    this.root.innerHTML = this.panel(body);
  }
}
