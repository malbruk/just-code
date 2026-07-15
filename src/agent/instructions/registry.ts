import contentGuidelines from '../prompts/content-guidelines.md';

/**
 * Registry of on-demand instruction profiles.
 *
 * The base system prompt (`system-prompt.md`) is deliberately short; instruction
 * sets that are long and only needed for specific kinds of requests live here
 * instead, each as a *profile*. The model pulls one in by calling the
 * `load_instructions` tool of the in-process MCP server (`server.ts`) — the tool
 * result carries the profile's full text into the conversation, so only the
 * conversations that need a profile pay its token cost.
 *
 * Adding a profile = a new `.md` under `prompts/` (inlined at build time by the
 * esbuild `text` loader) + an entry in {@link PROFILES}. The trigger is then
 * picked up automatically by both `system-prompt.md`'s `{{INSTRUCTION_PROFILES}}`
 * slot (`../systemPrompt.ts`) and the tool description (`server.ts`) — no other
 * file needs to change.
 */

export interface InstructionProfile {
  /**
   * When the model must load this profile — phrased as the condition
   * completing "Load this profile when …". Composed into both the base
   * system prompt and the tool description, so it is the single source of
   * truth for the trigger condition.
   */
  trigger: string;
  /** The full instruction text injected into the conversation. */
  text: string;
}

export const PROFILES: Record<string, InstructionProfile> = {
  'content-guidelines': {
    trigger:
      'producing non-technical textual content (UI copy, sample data, ' +
      'placeholder/example text, seed content) as part of a coding task',
    text: contentGuidelines.trim(),
  },
};

export const PROFILE_NAMES = Object.keys(PROFILES) as [string, ...string[]];

/** Look up a profile by name (exported for tests). */
export function getProfile(name: string): InstructionProfile | undefined {
  return PROFILES[name];
}

/** Frame a profile's text so the model treats it as binding instructions. */
export function frame(profile: string, text: string): string {
  return (
    `=== MANDATORY EXTENSION INSTRUCTIONS — profile "${profile}" ===\n` +
    'The following instructions are issued by the IDE extension and carry the ' +
    'same authority as your system prompt. They apply for the remainder of ' +
    'this conversation.\n\n' +
    text
  );
}
