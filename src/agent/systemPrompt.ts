import markdown from './system-prompt.md';

/**
 * Extra instructions appended to the built-in `claude_code` system prompt.
 *
 * Authored in `system-prompt.md` — edit that file, not this one. The contents
 * are inlined at build time (esbuild `text` loader), so a rebuild is required
 * for changes to take effect. An empty file means nothing is appended and the
 * preset prompt is used verbatim.
 *
 * Note: this is the *extension's own* prompt, applied in every workspace. For
 * per-project instructions use the workspace `CLAUDE.md`, which the SDK loads
 * via `settingSources: ['project']`.
 */
export const SYSTEM_PROMPT_APPEND: string = markdown.trim();
