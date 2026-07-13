/**
 * The IDE-agnostic core of the IntelliJ Node sidecar.
 *
 * It owns exactly one {@link AgentSession} (the same agent loop the VS Code
 * extension runs — imported from `@just-code/core`) and routes the
 * session-driving subset of the `WebviewToHost` protocol into it. Everything
 * the session emits comes back out through {@link SidecarPorts.send} as
 * `HostToWebview` messages.
 *
 * The two host collaborators the session needs are supplied as the core port
 * interfaces: a `LogSink` (console-backed by default) and an `EditTracker`.
 * IntelliJ renders diffs on the Kotlin side, so the default edit tracker is a
 * no-op — `finalizeDiff` yields nothing and `snapshot` does nothing.
 *
 * This module has no dependency on `process`, stdio, or the SDK's concrete
 * runtime, which is what makes it unit-testable with a stubbed SDK. The thin
 * `main.ts` wires it to real stdin/stdout.
 */
import { AgentSession } from '@just-code/core/agent/session.js';
import type { EditTracker, LogSink } from '@just-code/core/agent/session.js';
import type { WebviewToHost, HostToWebview, ChatMessage } from '@just-code/core';
import type { Options } from '@just-code/core/agent/sdk.js';

export interface SidecarPorts {
  /** Emit a protocol message to the client (IntelliJ Kotlin → JCEF webview). */
  send(msg: HostToWebview): void;
  /**
   * Build SDK `Options` for a fresh session. The real `main.ts` fills in cwd,
   * the resolved native `claude` binary, presets, and `abortController`; tests
   * pass a minimal object because a stubbed SDK ignores it.
   */
  buildOptions(abortController: AbortController): Options;
  /** Override the injected log sink (defaults to console). */
  log?: LogSink;
  /** Override the injected edit tracker (defaults to a no-op). */
  edits?: EditTracker;
}

const consoleLog: LogSink = {
  warn: (...args) => console.error('[sidecar][warn]', ...args),
  error: (...args) => console.error('[sidecar][error]', ...args),
};

const noopEdits: EditTracker = {
  snapshot: () => {},
  finalizeDiff: async () => undefined,
};

let counter = 0;
function userMessageId(): string {
  return `u-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export class Sidecar {
  private session: AgentSession | undefined;

  constructor(private readonly ports: SidecarPorts) {}

  private ensureSession(): AgentSession {
    if (this.session) return this.session;
    const abortController = new AbortController();
    this.session = new AgentSession({
      post: (msg) => this.ports.send(msg),
      options: this.ports.buildOptions(abortController),
      abortController,
      log: this.ports.log ?? consoleLog,
      edits: this.ports.edits ?? noopEdits,
    });
    this.session.start();
    return this.session;
  }

  /** Route one inbound protocol message. Non-session messages are ignored. */
  handle(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'submit': {
        const session = this.ensureSession();
        const message: ChatMessage = {
          id: userMessageId(),
          role: 'user',
          blocks: [{ type: 'text', text: msg.text }],
          attachments: msg.attachments,
          createdAt: Date.now(),
        };
        // Images/@-mention expansion are host concerns handled Kotlin-side before
        // this point; the sidecar submits the resolved prompt text.
        session.submit(message, msg.text);
        break;
      }
      case 'stop':
        void this.session?.interrupt();
        break;
      case 'setModel':
        void this.session?.setModel(msg.model);
        break;
      case 'setPermissionMode':
        void this.session?.setPermissionMode(msg.mode);
        break;
      case 'setThinking':
        void this.session?.setThinking(msg.enabled);
        break;
      case 'newChat':
        this.session?.dispose();
        this.session = undefined;
        break;
      default:
        // Permissions, history, completions, auth, editor context, etc. are
        // owned by the Kotlin plugin, not the agent loop. Ignored here.
        break;
    }
  }

  dispose(): void {
    this.session?.dispose();
    this.session = undefined;
  }
}
