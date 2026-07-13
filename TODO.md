# TODO — Multi-IDE roadmap (IntelliJ + Cursor/Kiro)

Continuation plan for making Just Code run beyond VS Code. Read this top-to-bottom
before starting a fresh session; it captures context not obvious from the code.

## Where we are (done)

A monorepo migration extracted an IDE-agnostic core so the same agent loop can run
outside VS Code. All of the following is **merged to `master` and pushed**, VS Code
behaviour unchanged:

- **`packages/core`** — `@just-code/core`, zero `vscode`/DOM. Holds the frozen
  `protocol.ts` (host↔webview contract) **and** the agent core: `agent/session.ts`
  (`AgentSession`, the streaming `query()` loop), `agent/{sdk,asyncQueue,errors,usage,
  editTools}.ts`, `util/text.ts`.
  - Imported two ways: bare `@just-code/core` (barrel = protocol) and subpath
    `@just-code/core/<path>.js` (e.g. `@just-code/core/agent/session.js`). Resolution:
    tsconfig `paths` (`@just-code/core` + `@just-code/core/*`) + esbuild `tsconfig`
    option + npm workspaces symlink. Core is **CJS-typed** (no `type: module`).
- **`AgentSession` is decoupled from `vscode`** via two port interfaces defined in
  `packages/core/src/agent/session.ts`:
  - `LogSink` — `{ warn(...args), error(...args) }`. VS Code passes its `Logger`;
    the sidecar passes a console logger.
  - `EditTracker` — `{ snapshot(id, fsPath), finalizeDiff(id): Promise<DiffView|undefined> }`.
    VS Code passes `PendingEditManager`; the sidecar passes a no-op (IntelliJ renders
    diffs IDE-side).
- **Webview is IDE-agnostic** (`webview-ui/`): all host I/O goes through
  `bridge.ts` (`HostBridge` = `post` / `onMessage` / `getState` / `setState`). VS Code
  adapter = `vscodeBridge.ts`; entry = `main.vscode.ts` (registers adapter, then imports
  `main.ts`). **IntelliJ will add `main.intellij.ts` + a JCEF adapter — `main.ts` itself
  never changes.**
- **`packages/intellij-plugin/sidecar`** — a Node process that runs `AgentSession`:
  - `src/sidecar.ts` — routes the session-driving subset of `WebviewToHost`
    (`submit`/`stop`/`setModel`/`setPermissionMode`/`setThinking`/`newChat`) into one
    `AgentSession`; injects console `LogSink` + no-op `EditTracker`.
  - `src/main.ts` — newline-delimited JSON over stdio (stdin line = `WebviewToHost`,
    stdout line = `HostToWebview`). Builds minimal SDK `Options` from env
    `JUST_CODE_CLAUDE_BIN` / `JUST_CODE_CWD`.
  - `build.mjs` — esbuild → `dist/sidecar.mjs` (ESM; core inlined, Agent SDK external).
  - Proven by `scratch/sidecar-test.mjs` (stubbed SDK, asserts protocol out).

### Branch model

- **`master`** — the clean, releasable baseline (monorepo + core extraction only). This
  is what ships to VS Code / Cursor / Kiro. No IntelliJ-specific code.
- **`intellij`** — `master` + 3 commits (HostBridge, session decouple, sidecar). This is
  where Steps 5 does its work. `git log master..intellij` = the IntelliJ-only delta.
- Do Step 5 on `intellij`. Do the VS Code / Open VSX parts of Step 6 on `master`; the
  JetBrains part on `intellij`.

### Verify commands (run after edits; all must stay green)

```bash
npx tsc --noEmit -p tsconfig.json          # whole project, both halves + sidecar
node esbuild.js                            # host + webview bundles
node scratch/activate-test.js              # every declared command registers
node scratch/sidecar-test.mjs              # (on intellij) sidecar protocol e2e
node packages/intellij-plugin/sidecar/build.mjs   # (on intellij) sidecar bundle
npx @vscode/vsce ls                        # VSIX packs cleanly
```
The machine is **Windows/PowerShell**; the Bash tool is Git Bash. Multi-line commit
messages go via a temp file + `git commit -F`. `scratch/` and `dist/`/`media/webview.js`
are gitignored.

---

## Step 5 — IntelliJ Kotlin plugin (on branch `intellij`)

Goal: a JetBrains plugin that hosts the shared webview in a JCEF browser and drives the
agent through the Node sidecar. This is a **different stack** (JVM/Kotlin/Gradle); the TS
`scratch/` harness cannot verify it — you need a JBR-with-JCEF runtime and
`./gradlew runIde` (an IntelliJ sandbox).

### 5.1 Gradle/Kotlin project skeleton
- In `packages/intellij-plugin/`, add a Gradle project (`build.gradle.kts`,
  `settings.gradle.kts`, `gradle.properties`, wrapper) using the **IntelliJ Platform
  Gradle Plugin** (`org.jetbrains.intellij.platform`, 2.x). Target a recent platform
  (e.g. 2024.2+) and Kotlin JVM.
- `src/main/resources/META-INF/plugin.xml` — plugin id (`dev.mabruk.just-code`),
  name, vendor, `<depends>com.intellij.modules.platform</depends>`, and register:
  a `ToolWindowFactory`, actions (New Chat, Stop, …), and any settings.
- **Fetch current docs via Context7** (`resolve-library-id` → `query-docs`) for the
  IntelliJ Platform Gradle Plugin + JCEF (`JBCefBrowser`, `JBCefJSQuery`) before writing
  build files — the API moves.

### 5.2 Build the shared webview for IntelliJ
- Add `webview-ui/src/main.intellij.ts` (parallel to `main.vscode.ts`): imports an
  `intellijBridge.ts` adapter, then `./main.js`.
- `webview-ui/src/intellijBridge.ts` — implements `HostBridge` over JCEF:
  - `post(msg)` → call an injected JS function that routes to `JBCefJSQuery` (Kotlin).
  - `onMessage(handler)` → expose a global (e.g. `window.__justCodeReceive`) the Kotlin
    side calls with each `HostToWebview` JSON.
  - `getState`/`setState` → `localStorage` (JCEF has no VS Code state store) or no-op.
- Add an esbuild target (new `build.mjs` under the plugin, or extend the sidecar build)
  that bundles `main.intellij.ts` (IIFE, browser) + copies `media/webview.css` into the
  plugin resources. Reuse `tsconfig` for the `@just-code/core` alias.

### 5.3 JCEF tool window (Kotlin)
- `ToolWindowFactory` creates a `JBCefBrowser`, loads an HTML shell that `<script>`s the
  bundled `webview.js` + `<link>`s `webview.css`. Mind JCEF CSP / `setOpenLinksInExternalBrowser`.
- Register a `JBCefJSQuery` so the webview's `post()` reaches Kotlin; inject a JS function
  so Kotlin can push `HostToWebview` into the webview.
- Theme: map JetBrains theme colors to the CSS variables the webview expects (the webview
  uses VS Code theme vars — provide equivalents, or a small shim stylesheet).

### 5.4 Sidecar process management (Kotlin)
- Spawn `node <plugin>/dist/sidecar.mjs` (bundle it into plugin resources at build).
  Resolve a `node` binary; set env `JUST_CODE_CWD` = project base path and
  `JUST_CODE_CLAUDE_BIN` = resolved `claude` binary (see 5.5).
- Bridge streams: read sidecar **stdout** lines → push each into the JCEF webview;
  webview `post()` → Kotlin → write JSON line to sidecar **stdin**. Handle process death,
  restart on New Chat, dispose on tool-window close.

### 5.5 Close the deferred gaps (needed for a *working* plugin)
- **Binary + auth resolution is still `vscode`-coupled** (`src/agent/cli.ts`,
  `src/agent/config.ts`). Options:
  - Extract a `vscode`-free binary resolver into `@just-code/core` (or the sidecar) so the
    sidecar can find `claude` itself; **or** resolve it Kotlin-side and pass via
    `JUST_CODE_CLAUDE_BIN` (simplest first cut).
  - Subscription auth uses the native binary's stored OAuth — Kotlin must drive
    `claude auth status|login|logout` and surface the in-panel auth gate.
- **IDE-side features the sidecar doesn't handle** (handle in Kotlin or extend the sidecar
  protocol handling): permissions (`canUseTool` → `permissionRequest`/decision round-trip),
  inline diffs (`DiffManager`), editor context, history, `@`/`/` completions, file open.
  Ship an MVP first (submit → stream → result), then add these.

### 5.6 Verify
- `./gradlew runIde` → sandbox IDE; open the tool window; confirm the webview renders, the
  sidecar spawns, a prompt streams a reply. Cannot be asserted headlessly — drive it.

---

## Step 6 — CI + publishing to three marketplaces

Goal: publish independently to VS Code Marketplace, Open VSX (serves **Cursor + Kiro**),
and JetBrains Marketplace. Each package versions on its own.

### 6.1 Publish targets
| Package | Tool | Marketplace | Notes |
|---|---|---|---|
| root (`vscode-ext`) | `vsce publish` | VS Code Marketplace | existing `release` skill |
| root (`vscode-ext`) | `ovsx publish` | **Open VSX** | one command on the **same `.vsix`**; unlocks Cursor + Kiro |
| `intellij-plugin` | `./gradlew publishPlugin` | JetBrains Marketplace | after Step 5 |

- **Fetch current `ovsx` CLI docs via Context7** before wiring (auth, namespace, publishing
  a pre-built `.vsix`). Open VSX needs a namespace + a `OVSX_PAT`.

### 6.2 Cursor + Kiro — no new code, but verify
Both are VS Code forks using the VS Code Extension API + Open VSX, so the **same VSIX**
runs on them. Checklist:
- Confirm `engines.vscode` (`^1.90`) ≤ each fork's bundled VS Code version.
- **Keybinding conflicts**: Cursor claims `Cmd/Ctrl+K` & `Cmd/Ctrl+L`; ours uses
  `ctrl+escape` and `ctrl+alt+k` (see `package.json` `contributes.keybindings`). Check for
  clashes; add `when` clauses if needed.
- **Install the built `.vsix` in Cursor and in Kiro and drive it** — webview renders,
  `claude` binary discovered (`src/agent/cli.ts` is IDE-independent), a turn streams. Do
  not claim support without a real run.

### 6.3 CI (GitHub Actions)
- Two/three workflows with **path filters**:
  - `vscode` workflow: triggers on `src/**`, `webview-ui/**`, `packages/core/**`,
    `package.json`, `media/**` → build + `vsce publish` + `ovsx publish`.
  - `intellij` workflow: triggers on `packages/intellij-plugin/**`, `packages/core/**` →
    `./gradlew publishPlugin`.
  - A change to `packages/core/**` can legitimately trigger both.
- Secrets: `VSCE_PAT`, `OVSX_PAT`, JetBrains `PUBLISH_TOKEN`.
- Reuse/adapt the existing `release` skill for the VS Code path (it already bumps version,
  builds, packages, publishes) — extend it to also `ovsx publish`.

---

## Guardrails / invariants (do not break)

- Keep the Agent SDK **external** everywhere (host bundle, sidecar). It is ESM and resolves
  its native `claude` binary via `import.meta.url` — bundling it breaks that.
- `protocol.ts` is the frozen contract; add to the union before using a new message.
- `@just-code/core` must stay `vscode`-free and DOM-free.
- `master` stays behaviour-neutral for VS Code and releasable at all times; IntelliJ work
  lives on `intellij`.
- After UI/webview changes, rebuild + reinstall before claiming a visual change works.
- See `CLAUDE.md` for the full architecture, file map, and per-area verifier scripts.
