#!/usr/bin/env node
/**
 * Publish preflight. Refuses to let a release go out with placeholder identity,
 * a stale changelog, or a mismatched version. Run by `npm run publish:check`.
 *
 * This exists because `vsce publish` is irreversible in the way that matters:
 * publishing claims the extension name permanently, even after an unpublish.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const problems = [];
const warnings = [];

// --- identity ------------------------------------------------------------
const PLACEHOLDER_PUBLISHERS = ['community', 'publisher', 'your-publisher', 'undefined'];
if (!pkg.publisher || PLACEHOLDER_PUBLISHERS.includes(pkg.publisher.toLowerCase())) {
  problems.push(
    `publisher is "${pkg.publisher}" — a placeholder. Create one at\n` +
      '    https://marketplace.visualstudio.com/manage\n' +
      '    then set "publisher" in package.json to that exact ID.',
  );
}

const repoUrl = pkg.repository?.url ?? '';
if (!repoUrl || /github\.com\/community\//i.test(repoUrl) || /your-org|example\.com/i.test(repoUrl)) {
  problems.push(`repository.url is "${repoUrl}" — a placeholder. The marketplace links to it; it must resolve.`);
}
for (const [field, url] of [['bugs.url', pkg.bugs?.url], ['homepage', pkg.homepage]]) {
  if (url && /github\.com\/community\//i.test(url)) problems.push(`${field} still points at the placeholder repo.`);
}

// --- a git remote should exist and agree with the manifest ----------------
let remote = '';
try {
  remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], // git prints to stderr when there is no remote
  }).trim();
} catch {
  problems.push('no git remote "origin". Push the repository before publishing.');
}
if (remote && repoUrl) {
  const norm = (u) => u.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/').toLowerCase();
  if (norm(remote) !== norm(repoUrl)) warnings.push(`git remote (${remote}) != package.json repository (${repoUrl}).`);
}

// --- version / changelog --------------------------------------------------
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
if (!new RegExp(`^##\\s+${pkg.version.replace(/\./g, '\\.')}\\s*$`, 'm').test(changelog)) {
  problems.push(`CHANGELOG.md has no "## ${pkg.version}" section.`);
}

// --- the VSIX must not carry the native runtime ---------------------------
const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
if (/^\s*!node_modules\/@anthropic-ai\/\*\*/m.test(ignore)) {
  problems.push('.vscodeignore re-includes ALL of @anthropic-ai — that ships the ~250 MB native binary.');
}

// --- LICENSE + icon -------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, 'LICENSE'))) problems.push('LICENSE is missing.');
const icon = path.join(ROOT, pkg.icon ?? '');
if (!pkg.icon || !fs.existsSync(icon)) problems.push('icon is missing.');
else {
  const b = fs.readFileSync(icon);
  const w = b.readUInt32BE(16);
  if (w < 128) problems.push(`icon is ${w}px wide; the marketplace wants at least 128x128.`);
}

// --- report ---------------------------------------------------------------
for (const w of warnings) console.log(`  warn   ${w}`);
if (problems.length === 0) {
  console.log(`\nPREFLIGHT: PASS — ${pkg.publisher}.${pkg.name}@${pkg.version} is ready to publish.`);
  process.exit(0);
}
console.error('\nPREFLIGHT: BLOCKED\n');
for (const p of problems) console.error(`  ✖ ${p}\n`);
console.error(`${problems.length} blocker(s). Nothing was published.`);
process.exit(1);
