import { z } from 'zod';
import { INSTRUCTIONS_SERVER_NAME, LOAD_INSTRUCTIONS_TOOL_NAME } from '@just-code/core';
import { loadSdk } from '@just-code/core/agent/sdk.js';
import type { McpSdkServerConfigWithInstance } from '@just-code/core/agent/sdk.js';
import contentGuidelines from './prompts/content-guidelines.md';

/**
 * On-demand instruction profiles.
 *
 * The base system prompt (`system-prompt.md`) is deliberately short; instruction
 * sets that are long and only needed for specific kinds of requests live here
 * instead, each as a *profile*. The model pulls one in by calling the
 * `load_instructions` tool of the in-process MCP server built below — the tool
 * result carries the profile's full text into the conversation, so only the
 * conversations that need a profile pay its token cost.
 *
 * Adding a profile = a new `.md` under `prompts/` (inlined at build time by the
 * esbuild `text` loader, like `system-prompt.md`) + an entry in {@link PROFILES}
 * + a trigger sentence in `system-prompt.md` telling the model when to load it.
 */

interface InstructionProfile {
  /** When the model should load this profile — shown in the tool description. */
  description: string;
  /** The full instruction text injected into the conversation. */
  text: string;
}

const PROFILES: Record<string, InstructionProfile> = {
  'content-guidelines': {
    description:
      'Rules for producing non-technical textual content (UI copy, sample data, ' +
      'placeholder/example text, seed content) as part of a coding task. Load ' +
      'BEFORE writing any such content.',
    text: contentGuidelines.trim(),
  },
};

const PROFILE_NAMES = Object.keys(PROFILES) as [string, ...string[]];

/** Frame a profile's text so the model treats it as binding instructions. */
function frame(profile: string, text: string): string {
  return (
    `=== MANDATORY EXTENSION INSTRUCTIONS — profile "${profile}" ===\n` +
    'The following instructions are issued by the IDE extension and carry the ' +
    'same authority as your system prompt. They apply for the remainder of ' +
    'this conversation.\n\n' +
    text
  );
}

/**
 * Build the in-process MCP server exposing `load_instructions`. One instance
 * per `query()`: the SDK binds the instance to the session's transport, so it
 * must not be shared across sessions.
 */
export async function createInstructionsServer(): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer, tool } = await loadSdk();
  const profileList = PROFILE_NAMES.map((n) => `- "${n}": ${PROFILES[n].description}`).join('\n');
  return createSdkMcpServer({
    name: INSTRUCTIONS_SERVER_NAME,
    tools: [
      tool(
        LOAD_INSTRUCTIONS_TOOL_NAME,
        'Load an extension-provided instruction profile into this conversation. ' +
          'Call it whenever the system prompt directs you to, BEFORE answering, ' +
          'and follow the returned instructions exactly. At most once per ' +
          `profile per conversation. Available profiles:\n${profileList}`,
        { profile: z.enum(PROFILE_NAMES) },
        async ({ profile }) => {
          const entry = PROFILES[profile];
          // The enum schema should make this unreachable; guard anyway so a
          // schema/registry drift degrades into a model-visible error.
          if (!entry) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Unknown profile "${profile}". Available: ${PROFILE_NAMES.join(', ')}`,
                },
              ],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: frame(profile, entry.text) }] };
        },
        // Keep the tool definition in the prompt unconditionally — it is tiny,
        // and the model must always know the loader exists for the on-demand
        // scheme to work. Only the profile text is pay-per-use.
        { alwaysLoad: true },
      ),
    ],
  });
}
