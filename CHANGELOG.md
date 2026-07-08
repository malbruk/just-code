# Changelog

## 1.0.0

First public release.

- **Scoped-behaviour layer** — a system-prompt policy (`src/agent/system-prompt.md`) is
  appended to the SDK's `claude_code` preset on every request, constraining the assistant
  to code, debugging, architecture, and related technical subjects.
- **Action gating** — every tool invocation passes through a `canUseTool` bridge: approve,
  deny, or allow-always, with permission modes (`default`, `acceptEdits`, `plan`,
  `bypassPermissions`).
- **The native Claude runtime is no longer bundled.** The extension discovers an existing
  Claude Code installation (`PATH`, npm global, native installer), following npm launcher
  scripts to the real executable. This takes the package from ~81 MB and one platform to
  ~1 MB and every platform. Requires `npm install -g @anthropic-ai/claude-code`.
- **MCP** — servers load from your user configuration and the workspace `.mcp.json`;
  `/mcp` reports live connection status. Previously only the `project` setting source was
  loaded, which silently dropped every globally-configured server.
- Declares `untrustedWorkspaces: false`: the SDK connects `.mcp.json` servers without a
  prompt, so opening an untrusted repository would start processes it defines.
- Errors on the message path are surfaced in the chat instead of being swallowed into the
  output channel, and a missing runtime now reports how to install it.
- New setting: `green-code.claudeExecutablePath`.

## 0.1.0

Initial release — an agentic chat panel for VS Code on the Claude Agent SDK.

- Agentic chat panel (activity bar view + editor-tab mode) with streaming responses.
- Full toolset via the Agent SDK (Read/Write/Edit/Bash/Grep/Glob/…).
- Tool-use cards with inline diffs; per-tool permission prompts and permission modes
  (default / acceptEdits / plan / bypassPermissions).
- Accept/reject edits individually or in bulk.
- Editor context sharing, add-selection/add-file commands, @-file mentions and
  /slash-command autocomplete.
- Model picker, usage & cost indicator.
- Conversation history & resume, stop/interrupt, API-key sign-in via SecretStorage.
