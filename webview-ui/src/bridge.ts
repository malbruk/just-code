/**
 * IDE-agnostic host bridge for the shared webview UI.
 *
 * The webview never talks to a specific IDE directly. Instead each host
 * (VS Code, IntelliJ, …) registers a {@link HostBridge} implementation via
 * {@link setBridge}, and the UI calls the lazy accessors below. This is what
 * lets the exact same `webview-ui/**` bundle run inside a VS Code webview and
 * inside an IntelliJ JCEF browser.
 *
 * Wiring: a thin per-IDE entry point (e.g. `main.vscode.ts`) imports its
 * adapter — which calls `setBridge(...)` at module load — and then imports the
 * shared `main.ts`. ES module ordering guarantees the bridge is set before any
 * of `main.ts`'s top-level code runs.
 */
import type { WebviewToHost } from '@just-code/core';

/** Minimal UI state persisted across reloads. */
export interface PersistedState {
  draft?: string;
  scrollTop?: number;
}

/**
 * The contract every host must satisfy. Deliberately tiny: one method per
 * capability the UI actually needs.
 */
export interface HostBridge {
  /** Send a strongly-typed message to the extension/plugin host. */
  post(msg: WebviewToHost): void;
  /**
   * Subscribe to messages coming *from* the host. The handler receives the raw
   * payload; the UI validates its shape before routing (a malformed payload
   * must never throw). VS Code delivers these as `window` `message` events;
   * other hosts may push them through an injected callback.
   */
  onMessage(handler: (data: unknown) => void): void;
  /** Read persisted UI state (draft, scroll). Absent host → empty object. */
  getState(): PersistedState;
  /** Persist UI state. No-op on hosts without a state store. */
  setState(state: PersistedState): void;
}

let active: HostBridge | undefined;

/** Register the host implementation. Called once, at startup, by an adapter. */
export function setBridge(bridge: HostBridge): void {
  active = bridge;
}

/** Post a strongly-typed message to the host. No-op before a bridge is set. */
export function post(msg: WebviewToHost): void {
  active?.post(msg);
}

/** Route messages arriving from the host to `handler`. */
export function onHostMessage(handler: (data: unknown) => void): void {
  active?.onMessage(handler);
}

export function getPersisted(): PersistedState {
  return active?.getState() ?? {};
}

export function setPersisted(state: PersistedState): void {
  active?.setState(state);
}
