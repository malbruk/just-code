import { z } from 'zod';
import { INSTRUCTIONS_SERVER_NAME, LOAD_INSTRUCTIONS_TOOL_NAME } from '@just-code/core';
import { loadSdk } from '@just-code/core/agent/sdk.js';
import type { McpSdkServerConfigWithInstance } from '@just-code/core/agent/sdk.js';
import type { PromptMeta } from './registry';

/**
 * `load_instructions` is a pure *signal*: calling it tells the extension that
 * the current request matches an instruction prompt of the active work
 * profile. The activation itself is intercepted in `tools/permissions.ts`
 * (the confirmation card) and executed by `SessionManager.applyPrompt` —
 * query restart with the prompt inlined in the system prompt, then an
 * automatic re-run of the request. The prompt text is deliberately NEVER
 * returned through this tool: instruction-bearing tool results read as prompt
 * injection and get dismissed.
 *
 * The tool description doubles as the always-in-context prompt list — models
 * follow tool descriptions closely, so the full "when to call" contract lives
 * here as well as in the system prompt (kept in sync via the registry: both
 * are composed from the same *advertised* set — enabled and not yet active).
 */
export function instructionsToolDescription(advertised: readonly PromptMeta[]): string {
  const promptList = advertised.map((p) => `- "${p.id}": applies to ${p.description}`).join('\n');
  return (
    'Signal that the current request matches an instruction prompt. ' +
    'Call it BEFORE answering any request that matches a prompt description ' +
    'below, then end your turn without answering — the user will be asked ' +
    "to activate the prompt, and the request will be re-issued with the prompt's " +
    'instructions in effect. At most once per prompt per conversation. ' +
    `Available instruction prompts:\n${promptList}`
  );
}

/**
 * The `load_instructions` handler (exported for tests). In production it is
 * unreachable: `canUseTool` intercepts every call and answers with a denial
 * that carries the outcome (activated / cancelled), so the tool never
 * executes. Kept as a safety net for configurations without the interceptor.
 */
export async function handleLoadInstructions({ prompt }: { prompt: string }) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Activation of instruction prompt "${prompt}" was requested. ` +
          'Activation is handled for you; end this turn without answering the original request.',
      },
    ],
  };
}

/**
 * Build the in-process MCP server exposing `load_instructions`, advertising
 * only the `advertised` prompts (enabled in the active profile and not yet
 * active). One instance per `query()`: the SDK binds the instance to the
 * session's transport, so it must not be shared across sessions. Callers must
 * not invoke this with an empty set — when no prompt is advertised the server
 * is simply not registered (`sessionManager.ensureSession`).
 */
export async function createInstructionsServer(advertised: readonly PromptMeta[]): Promise<McpSdkServerConfigWithInstance> {
  if (advertised.length === 0) throw new Error('createInstructionsServer called with no advertised prompts');
  const { createSdkMcpServer, tool } = await loadSdk();
  return createSdkMcpServer({
    name: INSTRUCTIONS_SERVER_NAME,
    tools: [
      tool(
        LOAD_INSTRUCTIONS_TOOL_NAME,
        instructionsToolDescription(advertised),
        { prompt: z.enum(advertised.map((p) => p.id) as [string, ...string[]]) },
        handleLoadInstructions,
        // Keep the tool definition in the prompt unconditionally — it is tiny,
        // and the model must always know the signal exists for the on-demand
        // scheme to work. Only activated prompt text costs tokens, and it
        // rides the system prompt of the re-anchored session.
        { alwaysLoad: true },
      ),
    ],
  });
}
