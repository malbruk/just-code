/**
 * Markdown files imported from TypeScript resolve to their raw text.
 * Backed by esbuild's `text` loader (see `esbuild.js`), which inlines the file
 * contents into the bundle at build time — nothing is read from disk at runtime.
 */
declare module '*.md' {
  const content: string;
  export default content;
}
