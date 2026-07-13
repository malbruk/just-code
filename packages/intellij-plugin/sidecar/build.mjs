/**
 * Build the Node sidecar bundle for the IntelliJ plugin.
 *
 * Mirrors the VS Code host build: `@just-code/core` is inlined, but the Agent
 * SDK is kept EXTERNAL (it is ESM and resolves its per-platform native `claude`
 * binary via `import.meta.url`, so it must be `import()`ed at runtime, not
 * bundled). Output is ESM so that dynamic import works cleanly.
 */
import { build } from 'esbuild';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: path.join(here, 'dist/sidecar.mjs'),
  external: ['@anthropic-ai/claude-agent-sdk'],
  // Resolve the @just-code/core path aliases the same way the root build does.
  tsconfig: path.join(repoRoot, 'tsconfig.json'),
  loader: { '.md': 'text' },
  logLevel: 'info',
});

console.log('[sidecar] built dist/sidecar.mjs');
