/**
 * Classification of a fatal session-stream error.
 *
 * The SDK surfaces failures as opaque `Error`s whose message is whatever the
 * native runtime wrote before dying ("Claude Code process exited with code 1",
 * an OAuth `invalid_grant`, a corrupted-config throw…). Showing that verbatim
 * tells the user nothing about what to do next, so we bucket the ones we can
 * recognise and attach an actionable explanation.
 *
 * Several of these are made *more likely* by running Anthropic's own Claude Code
 * extension at the same time: both drive the same local runtime, which stores
 * credentials and config in single, unlocked files under `~/.claude`.
 */

/** Which failure mode a stream error represents. */
export type SessionErrorKind = 'auth' | 'usageLimit' | 'configConflict' | 'runtimeExit' | 'unknown';

export interface ClassifiedError {
  kind: SessionErrorKind;
  /** Friendly text for the transcript. */
  message: string;
  /** The original error text, for the output channel. */
  raw: string;
  /** True when concurrent Claude Code usage is a plausible cause. */
  concurrencyRelated: boolean;
}

const PATTERNS: { kind: SessionErrorKind; re: RegExp; concurrencyRelated: boolean }[] = [
  // The OAuth refresh token in ~/.claude/.credentials.json rotates on use. Two
  // runtimes refreshing at the same moment race, and the loser gets invalid_grant.
  {
    kind: 'auth',
    re: /invalid_grant|oauth.*(refresh|token).*fail|token refresh failed|failed to refresh access token|authentication_error|\bunauthorized\b|\b401\b|not logged in|please run .*login/i,
    concurrencyRelated: true,
  },
  // ~/.claude.json is rewritten wholesale on every run, with no lock. Two
  // concurrent writers can tear it; the runtime then refuses to start.
  {
    kind: 'configConflict',
    re: /config file corrupted|corrupted config|settings have been restored from backup|restoring from backup/i,
    concurrencyRelated: true,
  },
  // Shared per-account budget: two agents burn the window twice as fast.
  {
    kind: 'usageLimit',
    re: /usage limit|rate.?limit|\b429\b|quota exceeded/i,
    concurrencyRelated: true,
  },
  {
    kind: 'runtimeExit',
    re: /process exited with code|process exited with signal|spawn .* enoent|closed its output stream/i,
    concurrencyRelated: false,
  },
];

const MESSAGES: Record<SessionErrorKind, string> = {
  auth: 'Your Claude sign-in could not be refreshed, so this session stopped.',
  configConflict:
    'The Claude Code configuration file (`~/.claude.json`) could not be read, so this session stopped.',
  usageLimit: 'Your plan’s usage limit was reached, so this session stopped.',
  runtimeExit: 'The Claude Code runtime stopped unexpectedly.',
  unknown: 'The session stopped because of an unexpected error.',
};

/**
 * Extra sentence appended when Anthropic's extension is also installed and the
 * failure is one that concurrent use can cause. Kept separate from
 * {@link MESSAGES} so we only make the claim when it is actually plausible.
 */
export const CONCURRENCY_HINT =
  'Anthropic’s Claude Code extension is also installed. Both share the same sign-in, `~/.claude.json`, and usage limits, ' +
  'and running a prompt in both at the same time can occasionally make one of them fail. Try again — if it keeps happening, ' +
  'run one at a time.';

/** Plain-text, one-sentence form of {@link CONCURRENCY_HINT} for notifications. */
export const CONCURRENCY_HINT_SHORT =
  'Anthropic’s Claude Code extension is also installed; the two share a sign-in and config file, and running both at once can cause this.';

/** Bucket a raw stream-error message into something the user can act on. */
export function classifyStreamError(raw: string): ClassifiedError {
  for (const { kind, re, concurrencyRelated } of PATTERNS) {
    if (re.test(raw)) return { kind, message: MESSAGES[kind], raw, concurrencyRelated };
  }
  return { kind: 'unknown', message: MESSAGES.unknown, raw, concurrencyRelated: false };
}

/**
 * The text shown inline in the transcript: the friendly summary, the
 * concurrency hint when it applies, and the raw error last so nothing is hidden.
 */
export function formatForTranscript(e: ClassifiedError, officialExtensionInstalled: boolean): string {
  const parts = [e.message];
  if (e.concurrencyRelated && officialExtensionInstalled) parts.push(CONCURRENCY_HINT);
  if (e.raw && e.raw !== e.message) parts.push(`\n\`\`\`\n${e.raw}\n\`\`\``);
  return parts.join('\n\n');
}
