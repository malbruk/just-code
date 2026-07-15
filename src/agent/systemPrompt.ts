import markdown from './system-prompt.md';
import { LOAD_INSTRUCTIONS_TOOL_NAME } from '@just-code/core';
import { PROFILES, PROFILE_NAMES } from './instructions/registry';

/**
 * Extra instructions appended to the built-in `claude_code` system prompt.
 *
 * Authored in `system-prompt.md` — edit that file, not this one. The contents
 * are inlined at build time (esbuild `text` loader), so a rebuild is required
 * for changes to take effect. An empty file means nothing is appended and the
 * preset prompt is used verbatim.
 *
 * The `{{INSTRUCTION_PROFILES}}` slot is filled from the instruction-profiles
 * registry (`./instructions/registry.ts`), so the base prompt and the
 * `load_instructions` tool description always advertise the same profiles.
 *
 * Note: this is the *extension's own* prompt, applied in every workspace. For
 * per-project instructions use the workspace `CLAUDE.md`, which the SDK loads
 * via `settingSources: ['project']`.
 */

function instructionProfilesList(): string {
  return PROFILE_NAMES.map(
    (name) => `- Call \`${LOAD_INSTRUCTIONS_TOOL_NAME}\` with profile \`${name}\` when ${PROFILES[name].trigger}.`,
  ).join('\n');
}

export const SYSTEM_PROMPT_APPEND: string = markdown
  .trim()
  .replace('{{INSTRUCTION_PROFILES}}', instructionProfilesList());
