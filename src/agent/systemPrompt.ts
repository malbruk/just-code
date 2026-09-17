import markdown from './prompts/system-prompt.md';
import { LOAD_INSTRUCTIONS_TOOL_NAME } from '@just-code/core';
import { frameActive, type InstructionPrompt, type PromptMeta, type WorkProfile } from './instructions/registry';

/**
 * Extra instructions appended to the built-in `claude_code` system prompt.
 *
 * `system-prompt.md` is pure scaffolding — the content comes from the registry
 * (`instructions/registry.ts`): the active work profile's system prompt and
 * its instruction prompts. The scaffolding is inlined at build time (esbuild
 * `text` loader); the profile content is read from `dist/prompts/` at runtime.
 *
 * Three marker-delimited sections are composed per session:
 *
 * - `{{#PROFILE_SECTION}}…{{/…}}` — the active work profile's own system
 *   prompt (`profile.md` body), dropped entirely in `base` mode.
 * - `{{#INSTRUCTION_PROMPTS_SECTION}}…{{/…}}` — the routing list. Kept only
 *   when at least one prompt is *advertised* (enabled but not yet active);
 *   `{{INSTRUCTION_PROMPTS}}` inside it is filled with those prompts'
 *   id+description lines and `{{LOAD_INSTRUCTIONS_TOOL}}` with the signal
 *   tool's name, matching the tool description (`instructions/server.ts`).
 * - `{{#ACTIVE_PROMPTS_SECTION}}…{{/…}}` — the prompts the user activated
 *   for this conversation, with `{{ACTIVE_PROMPTS}}` filled with their FULL
 *   framed text. This is the delivery channel: prompt instructions ride the
 *   system prompt (trusted), never a tool result (untrusted; models dismiss
 *   instruction-bearing tool results as prompt injection).
 *
 * Note: this is the *extension's own* prompt, applied in every workspace. For
 * per-project instructions use the workspace `CLAUDE.md`, which the SDK loads
 * via `settingSources: ['project']`.
 */

const section = (name: string) =>
  new RegExp(`\\{\\{#${name}\\}\\}\\n?([\\s\\S]*?)\\{\\{\\/${name}\\}\\}\\n?`);

function fillSection(text: string, name: string, keep: boolean, fill: (body: string) => string): string {
  return text.replace(section(name), (_m, body: string) => (keep ? fill(body) : ''));
}

/**
 * Build the system-prompt append.
 *
 * @param profile the active work profile, whose system prompt leads the append
 *   (`undefined` in `base` mode — then nothing profile-specific is appended).
 * @param advertised prompts offered for routing (enabled, not yet active).
 * @param active prompts the user activated — their full text is inlined.
 */
export function buildSystemPromptAppend(
  profile: WorkProfile | undefined,
  advertised: readonly PromptMeta[],
  active: readonly InstructionPrompt[] = [],
): string {
  let out = fillSection(markdown.trim(), 'PROFILE_SECTION', !!profile && profile.systemPrompt.length > 0, (body) =>
    body.replace('{{PROFILE_PROMPT}}', profile!.systemPrompt),
  );
  out = fillSection(out, 'INSTRUCTION_PROMPTS_SECTION', advertised.length > 0, (body) =>
    body
      .replace('{{LOAD_INSTRUCTIONS_TOOL}}', LOAD_INSTRUCTIONS_TOOL_NAME)
      .replace('{{INSTRUCTION_PROMPTS}}', advertised.map((p) => `- \`${p.id}\`: ${p.description}`).join('\n')),
  );
  out = fillSection(out, 'ACTIVE_PROMPTS_SECTION', active.length > 0, (body) =>
    body.replace('{{ACTIVE_PROMPTS}}', active.map((p) => frameActive(p)).join('\n\n')),
  );
  return out.trim();
}
