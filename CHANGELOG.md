# Changelog

## 1.1.2

- **Attachments no longer stick to the composer after sending.** Files and images pinned to a
  prompt stayed in the input once the turn was submitted, and silently rode along on the next
  one. They are now dropped when the turn goes out. The active-editor chip is untouched — it
  tracks the editor, not the prompt, so it stays put as before. This completes the fix that
  1.1.1 only removed the broken import for: `clearAttachments` was called for but never
  written.
- **Fable 5 is selectable.** The model existed in the `ModelId` type but was missing from the
  `MODELS` list that paints the picker, so it never appeared. Fable 5 is now the most capable
  entry; Opus 4.8 is described as highly capable and autonomous rather than "most capable".
- **`/switch model` opens the model picker.** Slash commands now carry aliases, and the `/`
  autocomplete matches them, so the action is reachable by the name it carries in the menu
  ("Switch model…") rather than only as the terse `/model`. The `/` query accepts spaces to
  make a multi-word alias typeable; a command followed by a real argument still closes the
  popup, so Enter submits as before.
- **No dollar figure on a subscription.** The per-turn cost was shown even when signed in with
  a Claude subscription, where the user is not billed per API cost. The guard for this existed
  but was dead: the webview never learned the auth method, because `applyInit` copied every
  field of the state except `auth.method`. It now shows only under an API key.
- **The streaming indicator is legible.** The gerund next to the mark was rendered at 0.92em in
  the muted description colour; it is now normal size in the normal foreground colour.

## 1.1.1

- **Fix a broken webview build.** `main.ts` imported `clearAttachments`, a symbol
  `state.ts` never exported, so `tsc --noEmit` failed and the webview bundle could not be
  produced from a clean checkout. Removed the dead import.

## 1.1.0

- **The extension is now called Just Code.** The rename goes all the way down: the marketplace
  id is `MaBrukDev.just-code`, and every command, setting, and context key moved from
  `yes-code.*` to `just-code.*`. This is a new listing — it does not update an existing
  Yes Code install, and settings and keybindings written against `yes-code.*` do not carry
  over. Re-set them under the new names.
- **New brand mark.** A coral speech bubble carrying `<Just/>`, replacing the green YES logo,
  across the marketplace icon, the activity bar, and the chat panel. The activity-bar icon is
  cut down to `</>` — at 24px the full wordmark renders as noise. The composer's accent colour
  follows the mark from green to coral.
- **Full tool output opens in the editor.** The transcript shows a tool's first few output
  lines; the rest now opens as a read-only editor tab instead of a scrolling box inside the
  chat, one tab per tool-use id.

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
- New setting: `just-code.claudeExecutablePath`.

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
