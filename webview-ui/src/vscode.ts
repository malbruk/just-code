/**
 * Thin, typed wrapper around the VS Code webview API.
 *
 * `acquireVsCodeApi` may only be called once per webview, so we cache the
 * handle. Everything here is defensive: outside a real webview host (e.g. a
 * plain browser during development) the calls degrade to no-ops instead of
 * throwing.
 */
import type { WebviewToHost } from '../../src/shared/protocol.js';

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

/** Post a strongly-typed message to the extension host. */
export function post(msg: WebviewToHost): void {
  try {
    api?.postMessage(msg);
  } catch {
    /* ignore */
  }
}

/** Minimal UI state we persist across reloads. */
export interface PersistedState {
  draft?: string;
  scrollTop?: number;
}

export function getPersisted(): PersistedState {
  try {
    const s = api?.getState();
    return (s && typeof s === 'object' ? (s as PersistedState) : {}) ?? {};
  } catch {
    return {};
  }
}

export function setPersisted(state: PersistedState): void {
  try {
    api?.setState(state);
  } catch {
    /* ignore */
  }
}
