import { z } from 'zod';
import { INSTRUCTIONS_SERVER_NAME, LOAD_INSTRUCTIONS_TOOL_NAME } from '@just-code/core';
import { loadSdk } from '@just-code/core/agent/sdk.js';
import type { McpSdkServerConfigWithInstance } from '@just-code/core/agent/sdk.js';
import { PROFILES, PROFILE_NAMES, getProfile, frame } from './registry';

/**
 * The tool description doubles as the always-in-context trigger list — models
 * follow tool descriptions closely, so the full "when to call" contract lives
 * here as well as in the system prompt (kept in sync via the registry).
 */
export function instructionsToolDescription(): string {
  const profileList = PROFILE_NAMES.map((n) => `- "${n}": ${PROFILES[n].trigger}`).join('\n');
  return (
    'Load an extension-provided instruction profile into this conversation. ' +
    'Call it whenever the system prompt directs you to, BEFORE answering, ' +
    'and follow the returned instructions exactly. At most once per ' +
    `profile per conversation. Available profiles:\n${profileList}`
  );
}

/** The `load_instructions` handler (exported for tests). */
export async function handleLoadInstructions({ profile }: { profile: string }) {
  const entry = getProfile(profile);
  // The enum schema should make this unreachable; guard anyway so a
  // schema/registry drift degrades into a model-visible error.
  if (!entry) {
    return {
      content: [
        { type: 'text' as const, text: `Unknown profile "${profile}". Available: ${PROFILE_NAMES.join(', ')}` },
      ],
      isError: true,
    };
  }
  return { content: [{ type: 'text' as const, text: frame(profile, entry.text) }] };
}

/**
 * Build the in-process MCP server exposing `load_instructions`. One instance
 * per `query()`: the SDK binds the instance to the session's transport, so it
 * must not be shared across sessions.
 */
export async function createInstructionsServer(): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer, tool } = await loadSdk();
  return createSdkMcpServer({
    name: INSTRUCTIONS_SERVER_NAME,
    tools: [
      tool(
        LOAD_INSTRUCTIONS_TOOL_NAME,
        instructionsToolDescription(),
        { profile: z.enum(PROFILE_NAMES) },
        handleLoadInstructions,
        // Keep the tool definition in the prompt unconditionally — it is tiny,
        // and the model must always know the loader exists for the on-demand
        // scheme to work. Only the profile text is pay-per-use.
        { alwaysLoad: true },
      ),
    ],
  });
}
