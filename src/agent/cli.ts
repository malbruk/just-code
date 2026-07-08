import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Locates and drives the native `claude` binary of a Claude Code installation,
 * so the extension can authenticate the same way the SDK's spawned runtime does.
 *
 * The binary is NOT bundled with this extension (it is ~250 MB and platform
 * specific). We discover an existing installation instead — see
 * {@link resolveClaudeBinary} for the search order.
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

const IS_WINDOWS = process.platform === 'win32';
const BIN_NAME = IS_WINDOWS ? 'claude.exe' : 'claude';

/**
 * True if `file` starts with the magic number of a native executable
 * (PE/`MZ`, ELF, or either Mach-O byte order).
 *
 * This is how we tell a real binary from a launcher script. npm's global
 * `claude` / `claude.cmd` / `claude.ps1` are text shims that re-exec the real
 * executable; handing one of those to the SDK as
 * `pathToClaudeCodeExecutable` fails, because the SDK spawns it directly
 * without a shell.
 */
function isNativeExecutable(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    if (head[0] === 0x4d && head[1] === 0x5a) return true; // "MZ"  — PE (Windows)
    if (head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF') return true; // ELF (Linux)
    const magic = head.readUInt32BE(0);
    // Mach-O, both byte orders, 32- and 64-bit, plus universal ("fat") binaries.
    return (
      magic === 0xfeedface || magic === 0xcefaedfe || magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xcafebabe
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Given a path that may be an npm launcher shim, return the real executable it
 * points at. Returns undefined if `candidate` is neither a native executable
 * nor a shim we can follow.
 *
 * npm shims embed the target path, relative to the shim's own directory:
 *   claude.cmd → "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
 *   claude     → exec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"
 */
function deshim(candidate: string): string | undefined {
  let real: string;
  try {
    if (!fs.existsSync(candidate)) return undefined;
    // Unix global installs symlink the bin into place; follow it first.
    real = fs.realpathSync(candidate);
  } catch {
    return undefined;
  }

  if (isNativeExecutable(real)) return real;

  // Not a binary — try to read it as a launcher script and extract the target.
  let text: string;
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > 64 * 1024) return undefined; // not a shim
    text = fs.readFileSync(real, 'utf8');
  } catch {
    return undefined;
  }

  const dir = path.dirname(real);
  // Match a quoted or bare path ending in the binary name. `%dp0%` and
  // `$basedir` both denote the shim's own directory.
  const re = new RegExp(String.raw`["']?(?:%dp0%|\$basedir|\$\{?basedir\}?)?[\\/]?([\w@.\-\\/]*${BIN_NAME.replace('.', '\\.')})["']?`, 'gi');
  for (const m of text.matchAll(re)) {
    const rel = m[1].replace(/\\/g, path.sep).replace(/\//g, path.sep);
    const target = path.resolve(dir, rel);
    if (target !== real && isNativeExecutable(target)) return target;
  }
  return undefined;
}

/** Search `PATH` for `claude` / `claude.exe` / `claude.cmd`, following shims. */
function fromPath(): string | undefined {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // On Windows the extensionless shell script comes first in PATH but is not
  // executable by `spawn`; try every name and let `deshim` sort it out.
  const names = IS_WINDOWS ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  for (const dir of entries) {
    for (const name of names) {
      const found = deshim(path.join(dir, name));
      if (found) return found;
    }
  }
  return undefined;
}

/** Node module resolution for a bundled or globally-installed package. */
function fromNodeResolution(): string | undefined {
  const arch = process.arch;
  const plat = process.platform;
  const suffixes = plat === 'linux' ? [`${plat}-${arch}`, `${plat}-${arch}-musl`] : [`${plat}-${arch}`];
  const specs = [
    // A binary bundled next to this extension (dev / self-packaged builds).
    ...suffixes.map((s) => `@anthropic-ai/claude-agent-sdk-${s}/${BIN_NAME}`),
    // The standalone Claude Code npm package.
    `@anthropic-ai/claude-code/bin/${BIN_NAME}`,
  ];
  try {
    const req = createRequire(__filename);
    for (const spec of specs) {
      try {
        const p = req.resolve(spec);
        const found = deshim(p);
        if (found) return found;
      } catch {
        /* try next candidate */
      }
    }
  } catch {
    /* createRequire unavailable */
  }
  return undefined;
}

/** Well-known install prefixes: npm global roots and the native installer. */
function fromKnownLocations(): string | undefined {
  const home = os.homedir();
  const dirs: string[] = [];

  if (IS_WINDOWS) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'npm'));
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', path.join(home, '.npm-global', 'bin'));
  }
  // The native installer, on every platform.
  dirs.push(path.join(home, '.local', 'bin'));
  dirs.push(path.join(home, '.claude', 'local'));

  for (const dir of dirs) {
    for (const name of IS_WINDOWS ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']) {
      const found = deshim(path.join(dir, name));
      if (found) return found;
    }
    // npm global prefixes hold the real binary under node_modules.
    const nested = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', BIN_NAME);
    if (isNativeExecutable(nested)) return nested;
  }
  return undefined;
}

/** Expand a leading `~` and any `${env:VAR}` placeholders in a user setting. */
function expandUserPath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return p.replace(/\$\{env:(\w+)\}/g, (_, name: string) => process.env[name] ?? '');
}

let cachedBin: string | null | undefined;

/**
 * Resolve the path of a real, spawnable `claude` executable, or undefined if
 * no Claude Code installation can be found.
 *
 * Search order (first hit wins):
 *   1. the `yes-code.claudeExecutablePath` setting, if set
 *   2. Node resolution — a bundled SDK binary, or the `@anthropic-ai/claude-code` package
 *   3. `PATH`
 *   4. well-known npm-global / native-installer locations
 *
 * Every candidate goes through {@link deshim}, so a launcher script or symlink
 * resolves to the executable it fronts. The result is cached; call
 * {@link clearBinaryCache} after the user installs Claude Code or edits the
 * setting.
 */
export function resolveClaudeBinary(): string | undefined {
  if (cachedBin !== undefined) return cachedBin ?? undefined;

  const configured = vscode.workspace.getConfiguration('yes-code').get<string>('claudeExecutablePath', '');
  if (configured && configured.trim()) {
    const found = deshim(expandUserPath(configured));
    // An explicit setting is authoritative: if it is wrong, fail loudly rather
    // than silently running some other installation the user did not choose.
    cachedBin = found ?? null;
    return found;
  }

  const found = fromNodeResolution() ?? fromPath() ?? fromKnownLocations();
  cachedBin = found ?? null;
  return found;
}

/** Forget the cached lookup, so the next call searches again. */
export function clearBinaryCache(): void {
  cachedBin = undefined;
}

/** Documentation URL shown when no installation is found. */
export const INSTALL_DOCS_URL = 'https://code.claude.com/docs/en/quickstart';

/** Human-readable install hint for the current platform. */
export function installHint(): string {
  return (
    'Claude Code was not found on this machine. Yes Code runs Anthropic’s Claude Code runtime locally, ' +
    'so it must be installed first:\n\n' +
    '```\nnpm install -g @anthropic-ai/claude-code\n```\n\n' +
    `See the [installation guide](${INSTALL_DOCS_URL}). ` +
    'If it is already installed somewhere unusual, set `yes-code.claudeExecutablePath` to its full path.'
  );
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
  const terminal = vscode.window.createTerminal({ name: 'Yes Code Login' });
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
  const env = { ...process.env, BROWSER: 'yes-code-no-browser' };
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
