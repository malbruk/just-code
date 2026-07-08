# Green Code

**Green Code** is a VS Code extension for agentic software development, built on
Anthropic's official **[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)**.
It provides a chat panel that can read, search, edit, and run code in your workspace,
with a **scoped-behaviour layer** that keeps the assistant on software-engineering
topics and a **permission layer** that gates every action it takes on your machine.

> **Independent project.** Green Code is not affiliated with, sponsored by, or
> endorsed by Anthropic PBC. "Anthropic", "Claude", and "Claude Code" are trademarks
> of Anthropic PBC, used here only to describe the underlying SDK and models this
> extension consumes.

## Why Green Code

The Claude Agent SDK exposes the same agent loop and toolset that powers Anthropic's
own coding tools. Green Code wraps that loop in a VS Code surface and adds one thing
the raw SDK does not provide: **an explicit, inspectable control layer**.

That layer has two independent halves:

**1. Scope enforcement.** A system-prompt policy is appended to the SDK's built-in
`claude_code` preset on every request, in every workspace, constraining the assistant
to code, debugging, architecture, and directly-related technical subjects. Requests
outside that scope — including attempts to smuggle out-of-scope content through code,
comments, or string literals — are declined. The policy lives in a single readable
file, [`src/agent/system-prompt.md`](src/agent/system-prompt.md), so it can be audited
and adapted rather than trusted blindly.

**2. Action gating.** Every tool invocation passes through a `canUseTool` bridge before
it touches your filesystem or shell. You approve, deny, or allow-always each one; file
edits are shown as inline diffs you can accept or reject individually, reverting to a
pre-edit snapshot on rejection.

The result is an agent whose purpose and permissions are both narrowed on purpose —
suited to organisations that want agentic coding assistance without a general-purpose
chatbot inside the editor.

## Features

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
| Open Green Code | `⌘Esc` | `Ctrl+Esc` |
| Add selection to chat | `⌘⌥K` | `Ctrl+Alt+K` |
| Accept all edits | `⌘Enter` | `Ctrl+Enter` |
| New chat (panel focused) | `⌘⌥N` | `Ctrl+Alt+N` |

## Authentication

Green Code does not operate a backend. It runs the Claude Agent SDK locally and the
SDK talks to Anthropic directly; your credentials never leave your machine. Two methods
are available (choose via **Green Code: Sign In**, or the `green-code.authMethod`
setting):

- **API key** — an Anthropic API key from the [Claude Console](https://platform.claude.com/),
  stored in VS Code SecretStorage. Also readable from the `ANTHROPIC_API_KEY` environment
  variable or the `green-code.apiKey` setting. This is the authentication method Anthropic
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
> behalf of their users." Green Code routes nothing on anyone's behalf — it invokes
> Anthropic's own runtime with your own local credentials — but if you intend to
> **redistribute** Green Code rather than run it yourself, API-key mode is the
> unambiguous choice.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `green-code.model` | `default` | Model to use. |
| `green-code.permissionMode` | `default` | Default permission mode. |
| `green-code.authMethod` | `subscription` | `subscription` or `apiKey`. |
| `green-code.apiKey` | `""` | Anthropic API key (prefer the Sign In command). |
| `green-code.maxTurns` | `100` | Max agent turns per request. |
| `green-code.extendedThinking` | `true` | Enable extended thinking. |
| `green-code.thinkingBudget` | `0` | Max thinking tokens (0 = model default). |
| `green-code.effort` | `default` | Reasoning effort level. |
| `green-code.autoModelFallback` | `false` | Fall back to another model when the primary fails. |
| `green-code.additionalDirectories` | `[]` | Extra directories the agent may access. |
| `green-code.loadProjectSettings` | `true` | Load workspace `CLAUDE.md` and settings. |

## Building from source

Requirements: Node.js 18+ and VS Code 1.90+.

```bash
npm install
npm run compile      # builds dist/extension.js and media/webview.js
npm run check-types  # tsc --noEmit
```

Press **F5** in VS Code (or the "Run Extension" launch config) to open an Extension
Development Host with the extension loaded, then open Green Code from the activity bar.

### Packaging a VSIX

```bash
npm run vsix
```

The Agent SDK is kept external from the bundle and ships inside the `.vsix` along with
its platform-native runtime, so the package is large (~81 MB) and is **built for one
platform at a time** — the runtime binary matches the machine that packaged it.

## Architecture

```
src/
  extension.ts            activation, command registration, context wiring
  panel/chatViewProvider  WebviewViewProvider + editor-tab panel; HTML/CSP/bridge
  agent/                  Agent SDK integration (streaming-input query loop)
  agent/system-prompt.md  the scope-enforcement policy  ← the control layer
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
