/**
 * VS Code adapter for the shared {@link HostBridge}.
 *
 * Wraps the VS Code webview API: `postMessage` for outgoing messages, the
 * `window` `message` event for incoming ones, and `getState`/`setState` for
 * persisted UI state. `acquireVsCodeApi` may only be called once per webview,
 * so the handle is cached. Outside a real webview host (e.g. a plain browser
 * during development) every call degrades to a no-op instead of throwing.
 *
 * Importing this module for its side effect registers the bridge, so the
 * VS Code entry point (`main.vscode.ts`) simply imports it before `main.ts`.
 */
import { setBridge, type HostBridge, type PersistedState } from './bridge.js';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;
try {
  api = acquireVsCodeApi();
} catch {
  api = undefined;
}

const vscodeBridge: HostBridge = {
  post(msg) {
    try {
      api?.postMessage(msg);
    } catch {
      /* ignore */
    }
  },
  onMessage(handler) {
    window.addEventListener('message', (event: MessageEvent) => handler(event.data));
  },
  getState(): PersistedState {
    try {
      const s = api?.getState();
      return (s && typeof s === 'object' ? (s as PersistedState) : {}) ?? {};
    } catch {
      return {};
    }
  },
  setState(state: PersistedState): void {
    try {
      api?.setState(state);
    } catch {
      /* ignore */
    }
  },
};

setBridge(vscodeBridge);
