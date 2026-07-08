import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Locates and drives the native `claude` binary that ships with the Agent SDK,
 * so the extension can authenticate the same way the SDK's spawned runtime does.
 *
 * Subscription (claude.ai) auth is handled entirely by this binary: the user
 * runs `claude auth login`, credentials are stored by the CLI, and the SDK
 * picks them up automatically as long as we don't force `ANTHROPIC_API_KEY`.
 */

export interface AuthStatus {
  loggedIn: boolean;
  /** e.g. 'claude.ai' (subscription), 'console'/'apiKey', 'bedrock'… */
  authMethod?: string;
  /** e.g. 'firstParty'. */
  apiProvider?: string;
  /** e.g. 'pro' | 'max'. */
  subscriptionType?: string;
  email?: string;
  orgName?: string;
}

let cachedBin: string | null | undefined;

/** Resolve the platform-specific native binary path, or undefined if missing. */
export function resolveClaudeBinary(): string | undefined {
  if (cachedBin !== undefined) return cachedBin ?? undefined;
  cachedBin = null;

  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const plat = process.platform;
  const arch = process.arch;
  const suffixes = plat === 'linux' ? [`${plat}-${arch}`, `${plat}-${arch}-musl`] : [`${plat}-${arch}`];

  // 1. Node resolution from this module (works in dev and when packaged).
  try {
    const req = createRequire(__filename);
    for (const s of suffixes) {
      try {
        const p = req.resolve(`@anthropic-ai/claude-agent-sdk-${s}/${binName}`);
        if (p && fs.existsSync(p)) return (cachedBin = p);
      } catch {
        /* try next candidate */
      }
    }
  } catch {
    /* createRequire unavailable — fall through to fs scan */
  }

  // 2. Filesystem fallback: scan node_modules next to the bundle / extension root.
  const roots = [path.join(__dirname, '..'), __dirname];
  for (const root of roots) {
    const dir = path.join(root, 'node_modules', '@anthropic-ai');
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith('claude-agent-sdk-')) continue;
        const candidate = path.join(dir, entry, binName);
        if (fs.existsSync(candidate)) return (cachedBin = candidate);
      }
    } catch {
      /* directory not present here */
    }
  }

  return undefined;
}

/** Run the binary non-interactively and capture stdout. */
function run(bin: string, args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Query the CLI's current authentication status. */
export async function getAuthStatus(bin: string): Promise<AuthStatus> {
  const { stdout } = await run(bin, ['auth', 'status', '--json']);
  try {
    const json = JSON.parse(stdout.trim());
    return {
      loggedIn: !!json.loggedIn,
      authMethod: json.authMethod,
      apiProvider: json.apiProvider,
      subscriptionType: json.subscriptionType,
      email: json.email,
      orgName: json.orgName,
    };
  } catch {
    return { loggedIn: false };
  }
}

/** Log out of the stored subscription/console session. */
export async function logout(bin: string): Promise<void> {
  await run(bin, ['auth', 'logout']);
}

/**
 * Launch the interactive OAuth login in a VS Code terminal. Returns the
 * terminal so the caller can keep a handle. `mode` selects subscription
 * (claude.ai) vs Console (API billing).
 *
 * Kept as a fallback; the primary flow is {@link startLogin}, which drives the
 * same binary as a headless child process so the whole experience stays inside
 * the extension panel.
 */
export function runLoginInTerminal(bin: string, mode: 'subscription' | 'console', email?: string): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name: 'Green Code Login' });
  const args = ['auth', 'login', mode === 'console' ? '--console' : '--claudeai'];
  if (email) args.push('--email', email);
  const quoted = `"${bin}" ${args.join(' ')}`;
  terminal.show(true);
  terminal.sendText(quoted, true);
  return terminal;
}

/** Outcome of a headless login attempt after a code has been submitted. */
export type LoginResult = 'ok' | 'invalid' | 'failed';

/** A headless `claude auth login` session driven from the extension. */
export interface LoginSession {
  /** Resolves with the OAuth URL to open in the browser. */
  readonly url: Promise<string | undefined>;
  /**
   * Feed the code the user pasted from the browser back to the CLI, and resolve
   * once the outcome is known: `'ok'` (child exited cleanly — caller should
   * confirm via `auth status`), `'invalid'` (the CLI rejected the code), or
   * `'failed'` (the child errored/closed unexpectedly).
   */
  submitCode(code: string): Promise<LoginResult>;
  /** Abort the login. */
  cancel(): void;
}

/**
 * Start `claude auth login` as a child process (no terminal). We capture the
 * printed OAuth URL so the extension can open it via `vscode.env.openExternal`,
 * then write the pasted code to the child's stdin. This mirrors the official
 * Claude Code login: open a browser link, paste the returned code.
 *
 * Note: on a bad code the CLI prints "Invalid code…" and keeps waiting rather
 * than exiting, so we watch its output for that string instead of only relying
 * on the child closing.
 */
export function startLogin(bin: string, mode: 'subscription' | 'console', email?: string): LoginSession {
  const args = ['auth', 'login', mode === 'console' ? '--console' : '--claudeai'];
  if (email) args.push('--email', email);

  // The CLI's OAuth flow starts a loopback server AND auto-opens the browser to
  // a `localhost` redirect, *while also* printing a manual paste-code URL. That
  // double-open is confusing and the loopback tab often fails in an embedded
  // context. We suppress the auto-open by pointing `$BROWSER` at a command that
  // won't resolve (the CLI treats "not found" as a no-op with no window) so the
  // only browser tab is the manual URL we open ourselves via `openExternal`.
  const env = { ...process.env, BROWSER: 'green-code-no-browser' };
  const child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });

  let buffer = '';
  let resolveUrl: (u: string | undefined) => void;
  const url = new Promise<string | undefined>((resolve) => (resolveUrl = resolve));
  let urlSettled = false;

  let submitted = false;
  let settleResult: ((r: LoginResult) => void) | undefined;
  const finish = (r: LoginResult): void => {
    if (settleResult) {
      const s = settleResult;
      settleResult = undefined;
      s(r);
    }
  };

  const onChunk = (chunk: string): void => {
    buffer += chunk;
    if (!urlSettled) {
      const m = buffer.match(/https?:\/\/\S+/);
      if (m) {
        urlSettled = true;
        resolveUrl(m[0].replace(/[)\].,]+$/, ''));
      }
    }
    // Once a code has been submitted, a rejection keeps the prompt open, so we
    // must detect it from the output rather than waiting for the child to exit.
    if (submitted && /invalid code|not.*valid|expired/i.test(chunk)) {
      finish('invalid');
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  };

  child.stdout?.on('data', (d) => onChunk(d.toString()));
  child.stderr?.on('data', (d) => onChunk(d.toString()));

  child.on('close', (code) => {
    if (!urlSettled) resolveUrl(undefined);
    // Clean exit after a submitted code → treat as success (auth status confirms).
    finish(submitted && (code === 0 || code === null) ? 'ok' : 'failed');
  });
  child.on('error', () => {
    if (!urlSettled) resolveUrl(undefined);
    finish('failed');
  });

  return {
    url,
    submitCode(code: string): Promise<LoginResult> {
      const result = new Promise<LoginResult>((resolve) => (settleResult = resolve));
      submitted = true;
      try {
        child.stdin?.write(code.trim() + '\n');
      } catch {
        finish('failed');
      }
      // Safety net: if nothing decisive happens, give up rather than hang.
      const timer = setTimeout(() => finish('failed'), 30000);
      void result.then(() => clearTimeout(timer));
      return result;
    },
    cancel(): void {
      try {
        child.stdin?.end();
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
