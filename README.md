# Yes Code

**Yes to code, no to everything else.**

**Yes Code** is a VS Code extension for agentic software development, built on
Anthropic's official **[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)**.
It provides a chat panel that can read, search, edit, and run code in your workspace —
and a scope policy that keeps the assistant on software engineering, and nothing else.

> **Independent project.** Yes Code is not affiliated with, sponsored by, or
> endorsed by Anthropic PBC. "Anthropic", "Claude", and "Claude Code" are trademarks
> of Anthropic PBC, used here only to describe the underlying SDK and models this
> extension consumes.

## Why Yes Code

The Claude Agent SDK exposes the same agent loop and toolset that powers Anthropic's
own coding tools: a capable general-purpose assistant that happens to be pointed at your
repository. Yes Code wraps that loop in a VS Code surface and narrows what it is for.

A scope policy is appended to the SDK's built-in `claude_code` system prompt on every
request, in every workspace. It confines the assistant to code, debugging, architecture,
and directly-related technical subjects. Personal, social, and sensitive human topics are
out of scope — and so is routing them through code. A request for a function, variable
name, comment, or string literal whose *content* is out of scope is declined even when
its wrapper is perfectly technical. Anything off-topic gets one answer, and it is always
the same one.

The policy is not a hidden filter. It is roughly ten lines of plain English in a single
file, [`src/agent/system-prompt.md`](src/agent/system-prompt.md), so you can read it,
tighten it, or adapt it to your organisation instead of trusting it blindly. It is a
strong instruction to the model rather than a hard technical guarantee, and it is written
to be audited on that basis.

The result is an agent that is a development tool and nothing else — suited to teams and
organisations that want agentic coding assistance without a general-purpose chatbot
inside the editor.

## Features

- **Scoped to development** — an auditable policy file keeps the assistant on code and
  technical subjects, and declines everything else.
- **Agentic chat panel** in the activity bar (and openable in an editor tab), with the
  SDK's full toolset (Read, Write, Edit, MultiEdit, Bash, Grep, Glob, Web, TodoWrite,
  Task/subagents, …).
- **Streaming responses** with live text and extended-thinking rendering.
- **Rich tool cards** — every tool call is a collapsible card with inputs, results, and
  inline diffs for file edits.
- **Permission prompts** — approve or deny each tool use, with "always allow", plus
  permission modes: `default`, `acceptEdits`, `plan` (read-only planning), and
  `bypassPermissions`.
- **Inline diffs & review** — accept/reject individual edits or all at once; rejecting
  reverts the file to its pre-edit snapshot.
- **Editor context** — automatically shares your active file and selection; add files or
  selections explicitly via right-click or `⌘⌥K` / `Ctrl+Alt+K`.
- **@-file mentions** and **/slash commands** with autocomplete in the composer.
- **Model picker** — switchable mid-session.
- **Usage & cost** — per-session token and USD cost indicator.
- **Conversation history** — browse and resume past sessions.
- **Checkpoints** — rewind file changes made during a turn.
- **Stop / interrupt** a running turn at any time.

## Keyboard shortcuts

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Open Yes Code | `⌘Esc` | `Ctrl+Esc` |
| Add selection to chat | `⌘⌥K` | `Ctrl+Alt+K` |
| Accept all edits | `⌘Enter` | `Ctrl+Enter` |
| New chat (panel focused) | `⌘⌥N` | `Ctrl+Alt+N` |

## Requirements

- VS Code 1.90+
- **Claude Code installed on your machine.** Yes Code drives Anthropic's own Claude
  Code runtime locally; it does not bundle it (the binary is ~250 MB and platform
  specific). Install it once:

  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

  The extension auto-detects the executable via `PATH`, npm global installs, and the
  native installer, following npm launcher scripts to the real binary. If yours lives
  somewhere unusual, set `yes-code.claudeExecutablePath`.

Yes Code must run in a **trusted workspace**. It edits files, executes shell commands,
and starts MCP servers declared in the workspace's `.mcp.json` — all of which are defined
by the repository you have open.

## Authentication

Yes Code does not operate a backend. It runs the Claude Agent SDK locally and the
SDK talks to Anthropic directly; your credentials never leave your machine. Two methods
are available (choose via **Yes Code: Sign In**, or the `yes-code.authMethod`
setting):

- **API key** — an Anthropic API key from the [Claude Console](https://platform.claude.com/),
  stored in VS Code SecretStorage. Also readable from the `ANTHROPIC_API_KEY` environment
  variable or the `yes-code.apiKey` setting. This is the authentication method Anthropic
  documents for software built on the Agent SDK.
- **Claude subscription** — signs in with your own Claude account through the bundled
  Claude runtime's OAuth flow (`claude auth login`). In this mode the extension does not
  pass `ANTHROPIC_API_KEY` to the runtime, so your account login is used rather than
  Console billing.

> **Before you rely on subscription mode**, read Anthropic's
> [Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance)
> policy and satisfy yourself that your usage fits it. As of this writing that policy
> states that developers building products on the Agent SDK "should use API key
> authentication", and that Anthropic "does not permit third-party developers to offer
> Claude.ai login or to route requests through Free, Pro, or Max plan credentials on
> behalf of their users." Yes Code routes nothing on anyone's behalf — it invokes
> Anthropic's own runtime with your own local credentials — but if you intend to
> **redistribute** Yes Code rather than run it yourself, API-key mode is the
> unambiguous choice.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `yes-code.model` | `default` | Model to use. |
| `yes-code.permissionMode` | `default` | Default permission mode. |
| `yes-code.authMethod` | `subscription` | `subscription` or `apiKey`. |
| `yes-code.apiKey` | `""` | Anthropic API key (prefer the Sign In command). |
| `yes-code.claudeExecutablePath` | `""` | Path to the `claude` executable (empty = auto-detect). |
| `yes-code.maxTurns` | `100` | Max agent turns per request. |
| `yes-code.extendedThinking` | `true` | Enable extended thinking. |
| `yes-code.thinkingBudget` | `0` | Max thinking tokens (0 = model default). |
| `yes-code.effort` | `default` | Reasoning effort level. |
| `yes-code.autoModelFallback` | `false` | Fall back to another model when the primary fails. |
| `yes-code.additionalDirectories` | `[]` | Extra directories the agent may access. |
| `yes-code.loadProjectSettings` | `true` | Load user/project/local settings — enables `CLAUDE.md` and MCP servers. |

### MCP

Yes Code loads MCP servers from your user configuration (`claude mcp add`) and from the
workspace `.mcp.json`. Run `/mcp` in the chat to see live connection status for each one.
This requires `yes-code.loadProjectSettings` to be on — it is what enables the settings
sources MCP is configured through.

## Building from source

Requirements: Node.js 18+ and VS Code 1.90+.

```bash
npm install
npm run compile      # builds dist/extension.js and media/webview.js
npm run check-types  # tsc --noEmit
```

Press **F5** in VS Code (or the "Run Extension" launch config) to open an Extension
Development Host with the extension loaded, then open Yes Code from the activity bar.

### Packaging a VSIX

```bash
npm run vsix
```

The Agent SDK's JavaScript is kept external from the bundle and ships inside the `.vsix`;
its ~250 MB native runtime is **not** bundled, so the package is ~4 MB and works on every
platform. The runtime is discovered at load time from your Claude Code installation.

## Architecture

```
src/
  extension.ts            activation, command registration, context wiring
  panel/chatViewProvider  WebviewViewProvider + editor-tab panel; HTML/CSP/bridge
  agent/                  Agent SDK integration (streaming-input query loop)
  agent/system-prompt.md  the scope policy  ← what makes this Yes Code
  tools/                  canUseTool permission bridge, diff compute & review
  context/                editor context tracking, @-file / slash completions
  history/                session list & resume via the SDK
  shared/protocol.ts      typed message contract shared with the webview  ← frozen
webview-ui/src/           vanilla-TS chat UI (bundled to media/webview.js)
media/                    webview.css, icons, bundled webview.js
docs/SDK-NOTES.md         verified notes on the Agent SDK surface
```

The extension host holds one long-lived `query()` per conversation in **streaming input
mode**, translating the SDK's `SDKMessage` stream into typed `HostToWebview` messages and
forwarding webview actions back. The webview is a dependency-free TypeScript app that
renders the transcript and composer using VS Code theme variables, so it matches any
color theme.

## License

MIT — see [LICENSE](LICENSE). The Claude Agent SDK and the Claude runtime it bundles are
licensed separately by Anthropic; your use of them is governed by Anthropic's terms.
