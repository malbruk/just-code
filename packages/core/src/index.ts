/**
 * Public surface of `@just-code/core` — the IDE-agnostic shared layer.
 *
 * This barrel is the single import target for every consumer: the VS Code
 * extension host, the shared webview UI, and (later) the IntelliJ Node sidecar.
 * It must stay free of any `vscode` or DOM dependency — types and plain
 * runtime constants only.
 */
export * from './protocol.js';
