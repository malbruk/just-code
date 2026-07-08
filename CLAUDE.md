# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A community VS Code extension that reimplements Anthropic's official **Claude Code**
extension on top of the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`).
It provides an agentic chat panel (activity-bar view + editor-tab mode) with the
full Claude Code toolset, streaming, tool cards, inline diffs, permission prompts,
editor context, @-file mentions, slash commands, model picker, usage, history, and
subscription/API-key auth.

Not affiliated with Anthropic. TypeScript throughout, `strict: true`.

## Commands

```bash
npm install
npm run compile      # build BOTH bundles via esbuild (dist/extension.js + media/webview.js)
npm run watch        # esbuild watch
npm run check-types  # tsc --noEmit -p tsconfig.json   (run this after edits)
npm run vsix         # package .vsix  (npx @vscode/vsce package)
```

Debug: press **F5** ("Run Extension" launch config → runs with `--disable-extensions`).
There is no unit-test runner; verify with the scripts below.

### Verifying changes (no VS Code GUI needed)

- `npx tsc --noEmit -p tsconfig.json` — must be clean (whole project, both halves).
- `node esbuild.js` — must build both bundles with no errors.
- `node scratch/activate-test.js` — stubs the `vscode` module, requires the built
  `dist/extension.js`, calls `activate()`, and asserts every command declared in
  `package.json` is registered and the `yes-code.chat` view provider registers.
  Run this after touching activation, commands, or the manifest.
- Native binary / auth path: `node -e` resolving `@anthropic-ai/claude-agent-sdk-<plat>/claude(.exe)`
  and running `claude auth status --json` (see git history / scratch for the exact snippet).

## Architecture

Two isolated halves that communicate ONLY through a typed message protocol:

```
Extension host (Node, CJS)  ⇄  src/shared/protocol.ts  ⇄  Webview UI (browser, IIFE)
        src/**                    (frozen contract)            webview-ui/**
```

- **`src/shared/protocol.ts` is the frozen contract.** Imported by BOTH sides. It
  defines `HostToWebview` / `WebviewToHost` messages and all view-model types
  (`ChatMessage`, `ToolUseView`, `DiffView`, `PermissionRequest`, `Attachment`,
  `AuthInfo`, `WebviewState`, …). It must stay dependency-free (no `vscode`, no DOM).
  Change it deliberately and update both sides + `check-types`.
- **Host → webview** posts `HostToWebview`; **webview → host** posts `WebviewToHost`.
  Never invent a message not in the protocol — add it to the union first.
- **esbuild builds two bundles** (`esbuild.js`): the host (`src/extension.ts` →
  `dist/extension.js`, CJS, `platform:node`) and the webview
  (`webview-ui/src/main.ts` → `media/webview.js`, IIFE, `platform:browser`).
- The webview is **vanilla TypeScript + DOM, no frameworks, no external/CDN
  resources** (strict CSP). All styles live in `media/webview.css` and use VS Code
  theme CSS variables only.

### Agent SDK integration (the important gotchas)

- The SDK is **ESM-only** and is kept **external** from the host bundle on purpose
  (`external: ['@anthropic-ai/claude-agent-sdk']` in `esbuild.js`). It is loaded via
  a dynamic `import()` in `src/agent/sdk.ts`. **Do not bundle it.** Consequence:
  `node_modules/@anthropic-ai/{claude-agent-sdk,sdk}` and `zod` ship inside the `.vsix`
  (see `.vscodeignore`).
- The **native `claude` runtime is NOT bundled.** The SDK's per-platform packages
  (`@anthropic-ai/claude-agent-sdk-<plat>`, ~250 MB each) are excluded from the `.vsix`,
  keeping it ~4 MB and platform-independent. `src/agent/cli.ts` discovers an existing
  Claude Code install instead, and `config.ts` pins `pathToClaudeCodeExecutable` to it.
  Users must have Claude Code installed (`npm i -g @anthropic-ai/claude-code`).
  - `resolveClaudeBinary()` search order: `yes-code.claudeExecutablePath` setting →
    Node resolution → `PATH` → known npm-global / native-installer dirs. An explicit
    setting is authoritative: if it is wrong, return undefined rather than silently
    running some other installation.
  - Every candidate goes through `deshim()`. **npm's global `claude` / `claude.cmd` /
    `claude.ps1` are text launcher scripts, not executables** — the SDK spawns the path
    directly with no shell, so handing it a shim fails. `deshim()` checks magic bytes
    (`MZ` / ELF / Mach-O) and, for a script, extracts the target path it re-execs.
  - The result is cached; `clearBinaryCache()` runs from `extension.ts` on setting change.
  - `node scratch/binary-test.js` verifies discovery in two scenarios: in-repo (a bundled
    binary is reachable) and out-of-tree (the shipped VSIX, which must find an install).
    It asserts the result has native-executable magic and spawns without a shell.
    **Run it after touching `cli.ts`.**
- `.vscodeignore` is **not** last-match-wins like `.gitignore`: an `exclude` line placed
  after a `!negation` will not override it. Narrow the negation itself.
- **Streaming-input mode**: one long-lived `query()` per conversation, fed by a
  push-based async iterable (`src/agent/asyncQueue.ts`). This is what enables
  `q.interrupt()`, `q.setModel()`, `q.setPermissionMode()`. The consume loop maps
  `SDKMessage`s → protocol messages (see `docs/SDK-NOTES.md` for exact message shapes).
- Options use the `claude_code` presets for `systemPrompt` (plus an `append` of
  `src/agent/system-prompt.md`) and `tools`.
- `settingSources: ['user', 'project', 'local']`, gated on the `loadProjectSettings`
  setting. **All three are required.** `user` (`~/.claude/settings.json`) is where
  globally-configured MCP servers live; passing only `['project']` silently drops them.
  This is also what loads `CLAUDE.md` and the workspace `.mcp.json`.
  - The SDK connects `.mcp.json` servers **without an approval prompt**, unlike the
    interactive CLI. That is arbitrary command execution from the repository, hence
    `capabilities.untrustedWorkspaces.supported: false` in `package.json`.
  - `scratch/mcp-test.mjs` (+ `scratch/echo-server.mjs`) is a real end-to-end check:
    it spins up a stdio MCP server in a temp workspace, runs a live `query()`, and
    asserts the tool is exposed and executes.
- `@modelcontextprotocol/sdk` is a **types-only** dependency here (`sdk.d.ts` imports
  from it; `sdk.mjs` never does — MCP runs inside the native binary). It is declared in
  `devDependencies` so `check-types` does not rely on npm's peer auto-install, and it is
  deliberately absent from the `.vsix`.

### Auth (two methods)

Controlled by `yes-code.authMethod` (`subscription` default, or `apiKey`):
- **subscription** — uses the native binary's stored claude.ai OAuth login. The
  extension checks/drives it via `claude auth status|login|logout` (`src/agent/cli.ts`),
  and in this mode **deliberately deletes `ANTHROPIC_API_KEY`** from the SDK env so
  the subscription is used, not Console billing.
- **apiKey** — key from SecretStorage → `yes-code.apiKey` setting → `ANTHROPIC_API_KEY`.

`SessionManager.signIn()` shows a QuickPick between the two.

## Important files

Host (`src/`):
- `extension.ts` — activation; registers the view provider + **all** commands
  (every `contributes.commands` entry must be registered here) + context keys + the
  first-run placement tip / `moveView` command.
- `agent/sessionManager.ts` — the brain: routes every `WebviewToHost` message, owns
  the current session, builds `WebviewState`, auth, history, new-chat/resume.
- `agent/session.ts` — one `AgentSession`: runs the `query()` loop, translates the
  SDK stream into protocol messages.
- `agent/sdk.ts` — dynamic ESM loader + type re-exports (`resolution-mode: 'import'`).
- `agent/config.ts` — reads settings, resolves auth, builds SDK `Options`
  (pins `pathToClaudeCodeExecutable` to the resolved binary).
- `agent/cli.ts` — resolves & drives the native `claude` binary for auth.
- `agent/asyncQueue.ts` — the streaming-input prompt queue.
- `tools/permissions.ts` — `canUseTool` bridge → `permissionRequest` / awaits decision.
- `tools/diff.ts` — pre-edit snapshots, applied-diff compute, accept/reject, native
  diff editor, `yes-code.hasPendingEdits` context key.
- `context/editorContext.ts` — tracks active file/selection/open files → `editorContext`.
- `context/completions.ts` — `@`-file search + `/`-slash command list.
- `history/history.ts` — `listSessions` / `getSessionMessages`.
- `panel/chatViewProvider.ts` — webview HTML (CSP + nonce), sidebar view + editor
  panel, message bridge fan-out.
- `util/{logger,nonce,text}.ts`.

Webview (`webview-ui/src/`):
- `main.ts` — bootstrap + `HostToWebview` router + global event delegation.
- `state.ts` — `AppState` + reducers. Note the **pinned vs ephemeral attachment**
  model: the active-editor chip is ephemeral (tracks the editor, `ephemeral:true`);
  `@`-mentions / add-to-chat produce **pinned** attachments that survive editor changes.
- `render.ts` — transcript reconciler, tool cards, diffs, thinking, permission cards.
- `composer.ts` — input, chips, `@`/`/` autocomplete (picking a file adds a chip),
  model/mode pickers, usage, send/stop.
- `markdown.ts` — small self-contained renderer (HTML-escaped). `icons.ts`, `vscode.ts`.

Relative imports across the two halves use explicit `.js` extensions
(e.g. `'../../src/shared/protocol.js'`) — required by `moduleResolution: Node16`;
esbuild resolves them to the `.ts` sources.

Reference: `docs/SDK-NOTES.md` (verified SDK v0.3.x surface). `scratch/` holds
throwaway verification scripts (gitignored).

## Conventions & guardrails

- Keep the host↔webview contract in `protocol.ts`; don't leak `vscode` or DOM types into it.
- A new user-facing command needs BOTH a `contributes.commands` entry in `package.json`
  AND registration in `extension.ts` (the activate-test enforces this).
- Don't re-bundle the Agent SDK; don't hardcode a binary path (resolve via `cli.ts`).
- `@types/vscode` is pinned to `~1.90` so `vsce` accepts `engines.vscode ^1.90`.
  Raising one requires raising the other.
- The webview must stay CSP-safe: no external resources, inline everything, use theme
  variables so it works in light/dark/high-contrast.
- After any change, run `check-types` + `node esbuild.js`; for host/manifest changes
  also run `scratch/activate-test.js`.
