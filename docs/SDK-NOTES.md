# Claude Agent SDK — integration notes (v0.3.202)

Package: `@anthropic-ai/claude-agent-sdk` — **ESM only** (`sdk.mjs`). esbuild bundles it
into our CJS extension bundle fine. Types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

## Core call

```ts
import { query, type Query, type SDKMessage, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const q: Query = query({ prompt, options });
for await (const msg of q) { /* msg: SDKMessage */ }
```

`prompt` is `string | AsyncIterable<SDKUserMessage>`. **Use streaming-input mode** (async
iterable) so we keep ONE long-lived query per session and push new user turns into it — that
is what unlocks `q.setPermissionMode()`, `q.setModel()`, `q.interrupt()` (control methods only
work in streaming input mode).

### Recommended options
```ts
const options: Options = {
  cwd: workspaceFolder,
  systemPrompt: { type: 'preset', preset: 'claude_code' }, // Claude Code system prompt
  tools: { type: 'preset', preset: 'claude_code' },        // full CC toolset (Read/Write/Edit/Bash/Grep/Glob/…)
  settingSources: ['project'],   // load workspace CLAUDE.md + settings (gate behind a config flag)
  permissionMode: 'default',     // 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  canUseTool,                    // interactive approval callback (below)
  includePartialMessages: true,  // stream text/thinking deltas
  maxTurns,
  model: model === 'default' ? undefined : model,
  abortController,
  additionalDirectories,
  env: { ...process.env, ANTHROPIC_API_KEY: apiKey },      // pass key via env
  stderr: (d) => log(d),
};
```

## Query control methods (streaming input only)
- `await q.interrupt()` — stop current turn.
- `await q.setPermissionMode(mode)` — change mode mid-session.
- `await q.setModel(model?)` — change model mid-session.

## Permission callback
```ts
type CanUseTool = (toolName, input, { signal, suggestions, title, description, blockedPath }) => Promise<PermissionResult>;
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string };
```
For "always allow", return `updatedPermissions: suggestions` (the array passed in) with the allow result.

## Streaming message shapes (the union `SDKMessage`)
- `{ type: 'system', subtype: 'init', session_id, ... }` — first message; capture `session_id`.
- `{ type: 'stream_event', event: BetaRawMessageStreamEvent, session_id }` — partial deltas.
  Inspect `event.type`:
    - `content_block_start` → `event.content_block` ({ type:'text'|'thinking'|'tool_use', ... }).
    - `content_block_delta` → `event.delta`: `{type:'text_delta', text}` | `{type:'thinking_delta', thinking}` | `{type:'input_json_delta', partial_json}`.
    - `content_block_stop`, `message_stop`.
- `{ type: 'assistant', message: BetaMessage, session_id }` — full assistant turn. `message.content`
  is an array of blocks: `{type:'text', text}`, `{type:'thinking', thinking}`,
  `{type:'tool_use', id, name, input}`. Use this as the authoritative turn content (deltas are for live typing).
- `{ type: 'user', message: MessageParam }` — includes tool_result blocks (`{type:'tool_result', tool_use_id, content, is_error}`). Use to mark tool cards success/error and capture result text.
- `{ type: 'result', subtype: 'success'|..., result, total_cost_usd, usage, num_turns, duration_ms, permission_denials }` — end of a request. `usage`: `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`.
- `{ type: 'system', subtype: 'permission_denied', tool_name, tool_use_id, message }` — auto-denied tool.

Ignore unrecognized message types gracefully (there are many: status, task_*, thinking_tokens, etc.).

## Sessions / history
- `listSessions(opts?)` → `SDKSessionInfo[]` ({ sessionId, summary, lastModified, cwd, firstPrompt, ... }).
- `getSessionMessages(sessionId, opts?)` → replay a past conversation.
- `deleteSession`, `renameSession`, `forkSession`.
- Resume: pass `options.resume = sessionId` (and optionally `forkSession: true`).

## Auth
Set `ANTHROPIC_API_KEY` in `options.env`. Read it from VS Code SecretStorage (preferred) or the
`just-code.apiKey` setting or the ambient env var. If none present, surface a "Sign in" prompt.
