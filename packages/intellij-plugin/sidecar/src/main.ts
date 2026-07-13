/**
 * Node sidecar entry point for the IntelliJ plugin.
 *
 * Transport: newline-delimited JSON over stdio. Each line on stdin is one
 * `WebviewToHost` message; each `HostToWebview` message is written to stdout as
 * one JSON line. The IntelliJ Kotlin plugin spawns this process and bridges
 * those streams to/from the JCEF webview.
 *
 * The Agent SDK stays external/ESM and is loaded lazily inside `@just-code/core`
 * (never bundled), exactly as in the VS Code host.
 */
import * as readline from 'readline';
import { Sidecar } from './sidecar.js';
import type { WebviewToHost, HostToWebview } from '@just-code/core';
import type { Options } from '@just-code/core/agent/sdk.js';

function send(msg: HostToWebview): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * Minimal SDK options for the sidecar. The Kotlin host provides the resolved
 * native `claude` binary and the workspace root via env; the rich settings/auth
 * resolution that VS Code's `config.ts` performs is a later slice (it is
 * `vscode`-coupled today).
 */
function buildOptions(abortController: AbortController): Options {
  const bin = process.env.JUST_CODE_CLAUDE_BIN;
  const cwd = process.env.JUST_CODE_CWD ?? process.cwd();
  const options = {
    cwd,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'default',
    includePartialMessages: true,
    abortController,
    ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
  } as Options;
  return options;
}

const sidecar = new Sidecar({ send, buildOptions });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: WebviewToHost | undefined;
  try {
    msg = JSON.parse(trimmed) as WebviewToHost;
  } catch {
    return; // ignore malformed lines
  }
  if (msg && typeof (msg as { type?: unknown }).type === 'string') {
    try {
      sidecar.handle(msg);
    } catch (err) {
      console.error('[sidecar] handle failed', err);
    }
  }
});
rl.on('close', () => sidecar.dispose());
