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

## Shell Environment

This machine runs Windows/PowerShell. Never use bash-only syntax (here-strings, single-quote
escaping, `$'...'`) in Bash tool calls. For multi-line git commit messages, write the message
to a temp file and use `git commit -F <file>`.

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
  `package.json` is registered and the `just-code.chat` view provider registers.
  Run this after touching activation, commands, or the manifest.
- `node scratch/usage-logic-test.mjs` — bundles `packages/core/src/agent/usage.ts`, issues a live
  `/usage` control request, and pins the window mapping + banner thresholds.
- `node scratch/account-dialog-test.mjs` — renders `webview-ui/src/account.ts` against
  a DOM shim: markup, escaping, the Day/Week toggle, the API-key and error states.
  Run both after touching account/usage code.
- `node scratch/delete-session-test.mjs` — creates a synthetic transcript under a temp
  workspace's project dir, then pins the real SDK's `deleteSession`: the `.jsonl` and the
  subagent subdirectory are unlinked, `listSessions` stops returning it, and a second
  delete throws. Run after touching history deletion.
- `node scratch/mention-chip-test.mjs` — drives the real `Composer` against a DOM shim:
  `@`-mention chip painting (offsets, escaping, non-mentions) and the completion
  popup's folder drill-down. `node scratch/file-completions-test.mjs` pins the host
  side of the same feature (folder derivation, trailing slashes, name/detail split).
  Run both after touching `composer.ts` or `context/completions.ts`.
- `node scratch/slash-usage-test.js` — drives the real `SessionManager.handleMessage`
  with a stubbed `vscode` to check `/usage` routing. It pins the config stub to an
  API-key session with no key, so an unknown command can't fall through and bill a
  real turn. Extend it when adding a client-side slash command.
- Native binary / auth path: `node -e` resolving `@anthropic-ai/claude-agent-sdk-<plat>/claude(.exe)`
  and running `claude auth status --json` (see git history / scratch for the exact snippet).

### Verifying UI changes

VS Code loads the *installed* extension copy, not the working tree. After any webview/CSS/icon
change, run the full build and reinstall the VSIX (or reload the Extension Development Host)
before claiming the change is visible. Never state "it should now show X" without a
build + reinstall step.

## Debugging

Before proposing a cause for a numeric/behavioral bug, gather real evidence (debug logs, actual
values, screenshots). Do not assert a cause from assumption — say "I need to see X" instead.

## Architecture

Two isolated halves that communicate ONLY through a typed message protocol:

```
Extension host (Node, CJS)  ⇄  @just-code/core  ⇄  Webview UI (browser, IIFE)
        src/**              (packages/core, frozen contract)  webview-ui/**
```

The shared contract now lives in the `packages/core` workspace and is imported by
both sides as the bare specifier **`@just-code/core`** (resolved via the tsconfig
`paths` map + esbuild's `tsconfig` option, and by npm workspaces at install time).
The file itself is `packages/core/src/protocol.ts`, re-exported through
`packages/core/src/index.ts`. This is the first step of a monorepo migration that
will let an IntelliJ plugin reuse the same core via a Node sidecar.

- **`@just-code/core` (`packages/core/src/protocol.ts`) is the frozen contract.** Imported by BOTH sides. It
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
  a dynamic `import()` in `packages/core/src/agent/sdk.ts`. **Do not bundle it.** Consequence:
  `node_modules/@anthropic-ai/{claude-agent-sdk,sdk}` and `zod` ship inside the `.vsix`
  (see `.vscodeignore`).
- The **native `claude` runtime is NOT bundled.** The SDK's per-platform packages
  (`@anthropic-ai/claude-agent-sdk-<plat>`, ~250 MB each) are excluded from the `.vsix`,
  keeping it ~4 MB and platform-independent. `src/agent/cli.ts` discovers an existing
  Claude Code install instead, and `config.ts` pins `pathToClaudeCodeExecutable` to it.
  Users must have Claude Code installed (`npm i -g @anthropic-ai/claude-code`).
  - `resolveClaudeBinary()` search order: `just-code.claudeExecutablePath` setting →
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
  push-based async iterable (`packages/core/src/agent/asyncQueue.ts`). This is what enables
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

Controlled by `just-code.authMethod` (`subscription` default, or `apiKey`):
- **subscription** — uses the native binary's stored claude.ai OAuth login. The
  extension checks/drives it via `claude auth status|login|logout` (`src/agent/cli.ts`),
  and in this mode **deliberately deletes `ANTHROPIC_API_KEY`** from the SDK env so
  the subscription is used, not Console billing.
- **apiKey** — key from SecretStorage → `just-code.apiKey` setting → `ANTHROPIC_API_KEY`.

`SessionManager.signIn()` shows a QuickPick between the two.

## Important files

Core (`packages/core/src/`) — the IDE-agnostic `@just-code/core` package,
consumed by the VS Code host, the shared webview, and (later) the IntelliJ Node
sidecar. **Zero `vscode`, zero DOM.** Host consumers import it via the bare
specifier `@just-code/core` (the barrel = `protocol.ts`) or the subpath alias
`@just-code/core/<path>.js` (e.g. `@just-code/core/agent/sdk.js`):
- `protocol.ts` — the frozen host↔webview message contract (see Architecture).
- `agent/session.ts` — **the agent brain**: one `AgentSession` owns a long-lived
  `query()` in streaming-input mode and translates the SDK stream into protocol
  messages. IDE-agnostic by construction: its two host collaborators are injected
  as the tiny `LogSink` and `EditTracker` **port interfaces** (defined here), not
  concrete `vscode` classes. VS Code passes its `Logger` + `PendingEditManager`
  (which structurally satisfy the ports); the IntelliJ sidecar passes a
  console-backed logger and a protocol-forwarding edit tracker.
- `agent/editTools.ts` — pure edit-tool helpers (`isEditTool`, `editToolPath`,
  `countLineDiff`, `predictAfter`). No I/O; shared by the VS Code diff manager and
  the sidecar.
- `agent/sdk.ts` — dynamic ESM loader + SDK type re-exports (`resolution-mode: 'import'`).
- `agent/asyncQueue.ts` — the streaming-input prompt queue.
- `agent/errors.ts` — stream-error classification / transcript formatting.
- `agent/usage.ts` — pure mapping of the runtime's structured `/usage` control request
  (`AgentSession.getUsage()`, an **experimental** SDK API) into the account dialog's
  view model, plus the plan-limit banner rules. Copy and the 70% display floor mirror
  the official CLI. Nothing here reads credentials — the binary owns the OAuth token.
- `util/text.ts` — pure path/format string helpers (`relPath`, `toolTitle`, …).

Host (`src/`):
- `extension.ts` — activation; registers the view provider + **all** commands
  (every `contributes.commands` entry must be registered here) + context keys + the
  first-run placement tip / `moveView` command.
- `agent/sessionManager.ts` — the host brain: routes every `WebviewToHost` message,
  owns the current `AgentSession` (from core), builds `WebviewState`, auth, history,
  new-chat/resume. Constructs the VS Code `Logger` + `PendingEditManager` and injects
  them into the session as its `LogSink`/`EditTracker` ports.
- `agent/config.ts` — reads settings, resolves auth, builds SDK `Options`
  (pins `pathToClaudeCodeExecutable` to the resolved binary).
- `agent/cli.ts` — resolves & drives the native `claude` binary for auth.
- `tools/permissions.ts` — `canUseTool` bridge → `permissionRequest` / awaits decision.
- `tools/diff.ts` — pre-edit snapshots, applied-diff compute, accept/reject, native
  diff editor, `just-code.hasPendingEdits` context key.
- `context/editorContext.ts` — tracks active file/selection/open files → `editorContext`.
- `context/completions.ts` — `@`-file search + `/`-slash command list.
- `history/history.ts` — `listSessions` / `getSessionMessages` / `deleteSession`. Deleting is
  **not** extension-local: the SDK unlinks `{sessionId}.jsonl` + the `{sessionId}/` subagent dir
  from `~/.claude/projects/<encoded-cwd>/`, so the conversation also vanishes from the `claude`
  CLI's `--resume`. Irreversible — `SessionManager.deleteSession` confirms with a modal first.
- `panel/chatViewProvider.ts` — webview HTML (CSP + nonce), sidebar view + editor
  panel, message bridge fan-out.
- `util/{logger,nonce}.ts`. (`util/text.ts` moved to `@just-code/core`.)

Webview (`webview-ui/src/`):
- **`bridge.ts` — the IDE-agnostic host bridge.** Defines the `HostBridge`
  interface (`post` / `onMessage` / `getState` / `setState`) and lazy accessors
  (`post`, `onHostMessage`, `getPersisted`, `setPersisted`). The shared UI talks
  ONLY to these — never to `acquireVsCodeApi` directly — so the same bundle can
  run in a VS Code webview and (later) an IntelliJ JCEF browser.
- `vscodeBridge.ts` — the VS Code adapter: implements `HostBridge` over
  `acquireVsCodeApi` + the `window` `message` event, and `setBridge(...)`s itself
  on import. `main.vscode.ts` is the esbuild entry (`media/webview.js`): it imports
  the adapter, then `main.ts`. ES module order guarantees the bridge is registered
  before `main.ts`'s top-level runs. An IntelliJ build adds a parallel
  `main.intellij.ts` + JCEF adapter; `main.ts` itself stays IDE-neutral.
- `main.ts` — bootstrap + `HostToWebview` router + global event delegation.
- `state.ts` — `AppState` + reducers. Note the **pinned vs ephemeral attachment**
  model: the active-editor chip is ephemeral (tracks the editor, `ephemeral:true`);
  add-to-chat / uploads produce **pinned** attachments that survive editor changes.
- `render.ts` — transcript reconciler, tool cards, diffs, thinking, permission cards.
- `composer.ts` — input, chips, `@`/`/` autocomplete (picking a file inserts `@path`
  inline in the textarea; `SessionManager.expandPrompt` splices the file's contents
  into the prompt on submit), model/mode pickers, usage, send/stop.
- `account.ts` — the "Account & usage" dialog (account rows, per-window meters, the
  Day/Week "what's contributing" breakdown). Opened from the `/` menu and the banner.
- `markdown.ts` — small self-contained renderer (HTML-escaped). `icons.ts`.

Relative imports across the two halves use explicit `.js` extensions
(e.g. `'../asyncQueue.js'`) — required by `moduleResolution: Node16`;
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

## Git Boundaries

Never modify git remotes, force-push, or change repository configuration unless explicitly
asked. Ask before any destructive or history-rewriting git operation.

## Language & RTL

This project handles mixed Hebrew/English content. Any user-facing text change must preserve
RTL/bidi correctness (use `dir="auto"` per block), and Hebrew string edits must be checked for
encoding issues before reporting results.
