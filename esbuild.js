// Build script for both the extension host bundle and the webview UI bundle.
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[build] started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}`);
      }
      console.log('[build] finished');
    });
  },
};

/** Extension host: Node CommonJS, `vscode` is external. */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  // `vscode` is provided by the host. The Agent SDK is kept EXTERNAL (not
  // bundled) on purpose: it is ESM and resolves a per-platform native `claude`
  // binary relative to its own file via `import.meta.url`. Bundling it into our
  // CJS output would break that resolution, so we `import()` it at runtime from
  // node_modules instead. This means node_modules/@anthropic-ai/** must ship
  // alongside the extension (see .vscodeignore).
  external: ['vscode', '@anthropic-ai/claude-agent-sdk'],
  // Honor the tsconfig `paths` map so `@just-code/core` resolves to the shared
  // source in packages/core (matching what tsc uses for type-checking).
  tsconfig: 'tsconfig.json',
  // Markdown imports (e.g. the appended system prompt) are inlined as raw text.
  loader: { '.md': 'text' },
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

/** Webview UI: browser IIFE, no externals. */
const webviewConfig = {
  entryPoints: ['webview-ui/src/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'media/webview.js',
  // Same shared-core alias resolution as the host bundle.
  tsconfig: 'tsconfig.json',
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

async function main() {
  const ctxs = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  if (watch) {
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[build] watching...');
  } else {
    await Promise.all(ctxs.map((c) => c.rebuild()));
    await Promise.all(ctxs.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
