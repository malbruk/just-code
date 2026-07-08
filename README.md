# Green Code

An open, community implementation of Anthropic's **Claude Code** VS Code extension,
built on the official **[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)**.
It brings the full agentic coding experience — a chat panel that can read, search,
edit, and run your codebase — into VS Code, mirroring the official extension's
feature set as closely as possible.

> ⚠️ Unofficial. Not affiliated with or endorsed by Anthropic. "Claude" and
> "Claude Code" are trademarks of Anthropic.

## Features

- **Agentic chat panel** in the activity bar (and openable in an editor tab), powered
  by the Claude Agent SDK with the full Claude Code toolset (Read, Write, Edit,
  MultiEdit, Bash, Grep, Glob, Web, TodoWrite, Task/subagents, …).
- **Streaming responses** with live text and extended-thinking rendering.
- **Rich tool cards** — every tool call is shown as a collapsible card with inputs,
  results, and inline diffs for file edits.
- **Permission prompts** — approve or deny each tool use, with "always allow", plus
  permission modes: `default`, `acceptEdits`, `plan` (read-only planning), and
  `bypassPermissions`.
- **Inline diffs & review** — accept/reject individual edits or all at once; rejecting
  reverts the file to its pre-edit snapshot.
- **Editor context** — automatically shares your active file and selection; add files
  or selections explicitly via right-click or `⌘⌥K` / `Ctrl+Alt+K`.
- **@-file mentions** and **/slash commands** with autocomplete in the composer.
- **Model picker** — Opus 4.8 / Sonnet 5 / Haiku 4.5, switchable mid-session.
- **Usage & cost** — per-session token and USD cost indicator.
- **Conversation history** — browse and resume past sessions.
- **Stop / interrupt** a running turn at any time.

## Keyboard shortcuts

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Open Green Code | `⌘Esc` | `Ctrl+Esc` |
| Add selection to chat | `⌘⌥K` | `Ctrl+Alt+K` |
| Accept all edits | `⌘Enter` | `Ctrl+Enter` |
| New chat (panel focused) | `⌘⌥N` | `Ctrl+Alt+N` |

## Getting started (development)

Requirements: Node.js 18+ and VS Code 1.90+.

```bash
npm install
npm run compile      # builds dist/extension.js and media/webview.js
```

Then press **F5** in VS Code (or run the "Run Extension" launch config) to open an
Extension Development Host with the extension loaded. Open the Green Code view from
the activity bar.

### Authentication

Two methods are supported (choose via **Green Code: Sign In**, or the
`green-code.authMethod` setting):

- **Claude subscription (default)** — sign in with your Claude Pro/Max account.
  This runs the bundled Claude runtime's OAuth login (`claude auth login`) in a
  terminal; credentials are stored by the runtime and used automatically. If you
  have already run `claude` and logged in elsewhere, it is detected on startup and
  no sign-in is needed.
- **API key** — paste an Anthropic API key (stored in VS Code SecretStorage), or set
  the `ANTHROPIC_API_KEY` environment variable / `green-code.apiKey` setting.

In subscription mode the extension deliberately does not pass `ANTHROPIC_API_KEY`
to the runtime, so your claude.ai login is used rather than Console billing.

### Packaging a VSIX

```bash
npm run package      # production bundle
npx vsce package --no-dependencies -o green-code.vsix
```

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `green-code.model` | `default` | Model to use (`default`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`). |
| `green-code.permissionMode` | `default` | Default permission mode. |
| `green-code.apiKey` | `""` | Anthropic API key (prefer the Sign In command). |
| `green-code.maxTurns` | `100` | Max agent turns per request. |
| `green-code.thinkingBudget` | `0` | Max thinking tokens (0 = model default). |
| `green-code.additionalDirectories` | `[]` | Extra directories the agent may access. |
| `green-code.loadProjectSettings` | `true` | Load workspace `CLAUDE.md` and settings. |

## Architecture

```
src/
  extension.ts            activation, command registration, context wiring
  panel/chatViewProvider  WebviewViewProvider + editor-tab panel; HTML/CSP/bridge
  agent/                  Claude Agent SDK integration (streaming-input query loop)
  tools/                  canUseTool permission bridge, diff compute & review
  context/                editor context tracking, @-file / slash completions
  history/                session list & resume via the SDK
  shared/protocol.ts      typed message contract shared with the webview  ← frozen
webview-ui/src/           vanilla-TS chat UI (bundled to media/webview.js)
media/                    webview.css, icons, bundled webview.js
docs/SDK-NOTES.md         verified notes on the Agent SDK surface
```

The extension host holds one long-lived `query()` per conversation in **streaming
input mode**, translating the SDK's `SDKMessage` stream into typed `HostToWebview`
messages and forwarding webview actions back. The webview is a dependency-free
TypeScript app that renders the transcript and composer using VS Code theme
variables, so it matches any color theme.

## License

MIT — see [LICENSE](LICENSE).
