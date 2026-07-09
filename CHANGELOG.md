# Changelog

## 1.0.3

- **Account & usage dialog.** The `/` menu and the new plan-limit banner open a dialog
  showing the signed-in account, per-window usage meters, and a Day/Week breakdown of
  what is consuming the plan. It reads the runtime's structured `/usage` control request
  (`src/agent/usage.ts`); nothing in the extension touches credentials — the native
  binary still owns the OAuth token.
- **Conversation titles.** New chats are titled from the typed prompt by a cheap Haiku
  summarization pass, run against a throwaway cwd so titling never leaves a junk
  conversation in the history list.
- **Delete a conversation from history.** Deleting is not extension-local: the SDK
  unlinks the transcript and its subagent directory under `~/.claude/projects/`, so the
  conversation also disappears from the `claude` CLI's `--resume`. It is irreversible,
  so it goes through a modal confirmation first.
- **Paste a screenshot into the composer.** Clipboard bitmaps become image attachments
  and are sent as Anthropic `image` content blocks. They never touch disk, and oversized
  images are downsampled client-side rather than being rejected by the API.
- **`@`-mentions are inline again.** Picking a file from the completion popup inserts
  `@path` into the textarea instead of adding a chip, and the file's contents are spliced
  into the prompt on submit. The popup also drills down into folders.
- **Actionable stream errors.** Fatal session errors were surfaced as whatever the native
  runtime wrote before dying. They are now bucketed (auth, usage limit, config conflict,
  runtime exit) with an explanation of what to do next.
- **Coexistence notice.** Anthropic's official extension drives the same local runtime,
  and shares its rotating OAuth token, its `~/.claude.json`, and the account's usage
  limits. A one-time note now explains this, since a simultaneous prompt in both panels
  can occasionally kill one session.
- A "working" indicator at the tail of a streaming turn, typing out gerunds beside the
  product mark.
- New brand mark, and a shorter marketplace description.

## 1.0.2

- The chat panel's empty state showed the old `</>` mark, which 1.0.1 missed: that glyph
  was inlined in the webview, not loaded from `media/`. It now uses the same brackets-and-
  checkmark mark as the extension icon, in `#D97757`. Unlike the activity-bar icon, this
  one is our own HTML, so the brand colour survives.
- Removed a duplicate copy of the logo in `render.ts`. Its comment claimed the copy avoided
  an import cycle, but `icons.ts` imports nothing and `render.ts` already imported from it.

## 1.0.1

- New icon: code brackets around a checkmark, in `#D97757`. The marketplace icon
  (`media/icon.png`) is rendered from a new vector source (`media/icon.svg`), and the
  activity-bar icon uses the same glyph. Note that VS Code paints activity-bar icons in
  the theme's foreground colour, so the brand colour shows only on the marketplace icon.
- Dropped two unused icon files from the package.

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
- New setting: `yes-code.claudeExecutablePath`.

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
