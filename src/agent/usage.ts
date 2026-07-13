/**
 * Plan rate-limit reporting: the data behind the "Account & usage" dialog and
 * the warning banner above the composer.
 *
 * The numbers come from the runtime's structured `/usage` control request
 * (`AgentSession.getUsage()`), which fronts claude.ai's `GET /api/oauth/usage`.
 * Nothing here reads credentials — the native binary owns the OAuth token and
 * only ever hands back utilization percentages.
 *
 * Copy and thresholds mirror the official Claude Code so the panel says the
 * same thing the CLI would. This module is pure: no `vscode`, no DOM.
 */
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from './sdk';
import type {
  AccountUsage,
  AuthInfo,
  RateLimitWarning,
  UsageBehavior,
  UsageBreakdown,
  UsageContributor,
  UsageWindow,
} from '@just-code/core';

/**
 * Claude Code only surfaces a limit warning once a window is 70% consumed —
 * below that the burn-rate signal is too noisy to act on. We apply the same
 * floor to the value we poll, so the banner appears at the same point the CLI
 * would show it.
 */
const WARN_AT_PCT = 70;

/** Display names for the plan windows, in the order the dialog lists them. */
const WINDOW_LABELS: { key: keyof RateLimits; label: string }[] = [
  { key: 'five_hour', label: 'Session (5hr)' },
  { key: 'seven_day', label: 'Weekly (7 day)' },
  { key: 'seven_day_opus', label: 'Weekly Opus' },
  { key: 'seven_day_sonnet', label: 'Weekly Sonnet' },
  { key: 'seven_day_oauth_apps', label: 'Weekly (OAuth apps)' },
];

/** Short limit names used inside the warning sentence, as Claude Code words them. */
const LIMIT_NAMES: Record<string, string> = {
  five_hour: 'session limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  seven_day_overage_included: 'Fable 5 limit',
  overage: 'usage credit limit',
};

/**
 * Claude Code's copy for each behavioral characteristic of local usage. The
 * headline takes the percentage; the body is the advice shown under it.
 */
const BEHAVIOR_COPY: Record<string, { headline: (pct: number) => string; body: string }> = {
  cache_miss: {
    headline: (p) => `${p}% of your usage hit a >100k-token cache miss`,
    body:
      'Uncached input is expensive, and often happens when sending a message to a session that has gone idle. ' +
      '/compact before stepping away keeps the cold-start small.',
  },
  long_context: {
    headline: (p) => `${p}% of your usage was at >150k context`,
    body: 'Longer sessions are more expensive even when cached. /compact mid-task, /clear when switching to new tasks.',
  },
  subagent_heavy: {
    headline: (p) => `${p}% of your usage came from subagent-heavy sessions`,
    body:
      'Each subagent runs its own requests. Be deliberate about spawning them — and consider configuring a cheaper ' +
      'model for simpler subagents.',
  },
  high_parallel: {
    headline: (p) => `${p}% of your usage was while 4+ sessions ran in parallel`,
    body: "All sessions share one limit. If you don't need them all at once, queueing uses it more evenly.",
  },
  cron: {
    headline: (p) => `${p}% of your usage came from sessions active for 8+ hours`,
    body: 'These are often background/loop sessions. Continuous usage can add up quickly so make sure it is intentional.',
  },
};

type RateLimits = NonNullable<SDKControlGetUsageResponse['rate_limits']>;
type Window = { utilization: number | null; resets_at: string | null } | null | undefined;

/** A window counts only when the server reported a real utilization number. */
function toWindow(key: string, label: string, w: Window): UsageWindow | undefined {
  if (!w || typeof w.utilization !== 'number') return undefined;
  return {
    key,
    label,
    utilization: clampPct(w.utilization),
    resetsAt: w.resets_at ?? undefined,
  };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toContributors(list: UsageContributor[] | undefined): UsageContributor[] {
  if (!Array.isArray(list)) return [];
  return list.filter((c) => c && typeof c.name === 'string' && typeof c.pct === 'number');
}

/** Map the runtime's behavior keys onto Claude Code's headline + advice. */
function toBehaviors(list: { key: string; pct: number }[] | undefined): UsageBehavior[] {
  if (!Array.isArray(list)) return [];
  const out: UsageBehavior[] = [];
  for (const b of list) {
    const copy = BEHAVIOR_COPY[b.key];
    if (!copy) continue; // a behavior key we don't have copy for yet
    out.push({ key: b.key, headline: copy.headline(clampPct(b.pct)), body: copy.body });
  }
  return out;
}

type RawBreakdown = NonNullable<SDKControlGetUsageResponse['behaviors']>['day'];

function toBreakdown(raw: RawBreakdown): UsageBreakdown {
  return {
    requestCount: raw?.request_count ?? 0,
    sessionCount: raw?.session_count ?? 0,
    behaviors: toBehaviors(raw?.behaviors),
    skills: toContributors(raw?.skills),
    agents: toContributors(raw?.agents),
    plugins: toContributors(raw?.plugins),
    mcpServers: toContributors(raw?.mcp_servers),
  };
}

/**
 * Fold the runtime's `/usage` response and the CLI's auth status into the view
 * model the dialog renders.
 *
 * `rate_limits_available` is false for API-key, Bedrock and Vertex sessions —
 * there is no plan to report, so `windows` comes back empty and the dialog
 * explains that rather than showing zeroed bars.
 */
export function toAccountUsage(res: SDKControlGetUsageResponse | undefined, auth: AuthInfo): AccountUsage {
  if (!res) return { auth, limitsAvailable: false, windows: [] };

  const limits = res.rate_limits;
  const windows: UsageWindow[] = [];

  if (limits) {
    for (const { key, label } of WINDOW_LABELS) {
      const w = toWindow(key, label, limits[key] as Window);
      if (w) windows.push(w);
    }
    // Per-model weekly windows the server adds dynamically (e.g. "Fable"). The
    // display name is server-supplied, so new models appear without a change here.
    for (const m of limits.model_scoped ?? []) {
      const w = toWindow(`model:${m.display_name}`, `Weekly ${m.display_name}`, m);
      if (w) windows.push(w);
    }
  }

  return {
    auth: { ...auth, plan: auth.plan ?? res.subscription_type ?? undefined },
    limitsAvailable: Boolean(res.rate_limits_available),
    windows,
    sessionCostUsd: typeof res.session?.total_cost_usd === 'number' ? res.session.total_cost_usd : undefined,
    breakdown: res.behaviors
      ? { day: toBreakdown(res.behaviors.day), week: toBreakdown(res.behaviors.week) }
      : undefined,
  };
}

/**
 * Render an absolute reset time the way Claude Code does: a bare clock time
 * ("3pm", "3:20pm") when it lands within a day, otherwise a dated one.
 */
function formatResetTime(at: Date): string {
  const hours = (at.getTime() - Date.now()) / 3_600_000;
  const withDate = hours > 24;
  const time = at
    .toLocaleString('en-US', {
      hour: 'numeric',
      minute: at.getMinutes() === 0 ? undefined : '2-digit',
      hour12: true,
    })
    .replace(/\s([AP]M)/i, (_, m: string) => m.toLowerCase());
  if (!withDate) return time;
  const date = at.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  return `${date}, ${time}`;
}

/**
 * Build the banner sentence for a window that has crossed the warning floor,
 * matching Claude Code: "You've used 92% of your session limit · resets 3pm".
 */
function warningMessage(key: string, utilization: number, resetsAt: Date | undefined): string {
  const name = LIMIT_NAMES[key] ?? (key.startsWith('model:') ? `${key.slice(6)} limit` : 'usage limit');
  const base = `You've used ${utilization}% of your ${name}`;
  return resetsAt ? `${base} · resets ${formatResetTime(resetsAt)}` : base;
}

function parseDate(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Derive a banner from polled window data — the path used when the dialog
 * refreshes and between turns, before any `rate_limit_event` has arrived.
 *
 * Only the single most-consumed window that crossed {@link WARN_AT_PCT} is
 * shown; stacking three near-identical banners helps nobody.
 */
export function warningFromWindows(windows: UsageWindow[]): RateLimitWarning | undefined {
  let worst: UsageWindow | undefined;
  for (const w of windows) {
    if (w.utilization < WARN_AT_PCT) continue;
    if (!worst || w.utilization > worst.utilization) worst = w;
  }
  if (!worst) return undefined;
  return {
    severity: worst.utilization >= 100 ? 'error' : 'warning',
    message: warningMessage(worst.key, worst.utilization, parseDate(worst.resetsAt)),
  };
}

/**
 * Derive a banner from a live `rate_limit_event`. The runtime has already
 * applied its burn-rate rules to the response headers, so `allowed_warning` is
 * authoritative — we only re-apply the same 70% display floor Claude Code uses,
 * so a low-utilization on-pace signal doesn't nag.
 *
 * `resetsAt` here is epoch **seconds**, not the ISO string the dialog gets.
 */
export function warningFromEvent(info: SDKRateLimitInfo): RateLimitWarning | undefined {
  if (!info || info.status === 'allowed') return undefined;

  const key = info.rateLimitType;
  // With no window named, say "usage limit" rather than guessing at one.
  const name = (key && LIMIT_NAMES[key]) || 'usage limit';
  const resetsAt = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : undefined;
  // `utilization` arrives as a 0-1 fraction on this event, unlike the dialog's 0-100.
  const pct = typeof info.utilization === 'number' ? clampPct(info.utilization * 100) : undefined;

  if (info.status === 'rejected') {
    return {
      severity: 'error',
      message: resetsAt
        ? `You've reached your ${name} · resets ${formatResetTime(resetsAt)}`
        : `You've reached your ${name}`,
    };
  }

  // allowed_warning
  if (pct === undefined) return { severity: 'warning', message: `Approaching your ${name}` };
  if (pct < WARN_AT_PCT) return undefined;
  return { severity: 'warning', message: key ? warningMessage(key, pct, resetsAt) : `You've used ${pct}% of your ${name}` };
}
