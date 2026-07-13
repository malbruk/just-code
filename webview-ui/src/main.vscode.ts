/**
 * VS Code webview entry point (esbuild's bundle entry → media/webview.js).
 *
 * Registers the VS Code host adapter, then runs the shared UI. The static
 * import order matters: `vscodeBridge` calls `setBridge(...)` at module load,
 * and ES module evaluation guarantees it completes before `main`'s top-level
 * code runs. An IntelliJ build will provide its own analogous entry
 * (`main.intellij.ts`) that registers a JCEF adapter instead.
 */
import './vscodeBridge.js';
import './main.js';
