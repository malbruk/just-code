import * as vscode from 'vscode';
import type { CompletionItem, HostToWebview, SlashCommand } from '@just-code/core';
import { getWorkspaceRoot } from '../agent/config';
import { relPath } from '@just-code/core/util/text.js';

/**
 * Static slash-command palette surfaced in the composer + `WebviewState`.
 * Mirrors the command set of Anthropic's official Claude Code, adapted for the
 * VS Code chat panel. Execution lives in `SessionManager.runSlashCommand`.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/add-dir', description: 'Add a working directory the agent can access', argHint: '<path>' },
  { name: '/agents', description: 'Manage agent (subagent) configurations' },
  { name: '/bug', description: 'Report a bug or give feedback' },
  { name: '/clear', description: 'Clear conversation history and free up context' },
  { name: '/compact', description: 'Compact the conversation to save context', argHint: '[instructions]' },
  { name: '/config', description: 'Open the Just Code settings' },
  { name: '/cost', description: 'Show token usage and cost for this session' },
  { name: '/doctor', description: 'Check the health of your Just Code installation' },
  { name: '/help', description: 'Show help and the list of available commands' },
  { name: '/init', description: 'Initialize the project with a CLAUDE.md guide' },
  { name: '/login', description: 'Sign in with your Claude account or API key' },
  { name: '/logout', description: 'Sign out of your Claude account' },
  { name: '/mcp', description: 'Manage MCP server connections' },
  { name: '/memory', description: 'Edit the project CLAUDE.md memory file' },
  {
    name: '/model',
    description: 'Switch the active model',
    argHint: '[model]',
    aliases: ['switch model', 'change model'],
  },
  { name: '/new', description: 'Start a new chat' },
  { name: '/permissions', description: 'Change the tool permission mode', argHint: '[mode]' },
  { name: '/release-notes', description: 'Show what is new in Just Code' },
  { name: '/resume', description: 'Resume a previous conversation' },
  { name: '/review', description: 'Review the current changes or a pull request', argHint: '[target]' },
  {
    name: '/rewind',
    description: 'Rewind the conversation and restore files to the last checkpoint',
    aliases: ['undo turn', 'checkpoint'],
  },
  { name: '/status', description: 'Show account, model, and workspace status' },
  { name: '/terminal-setup', description: 'Tips for using Claude Code in the terminal' },
  { name: '/usage', description: 'Show account details and plan usage limits' },
  { name: '/vim', description: 'Toggle Vim keybindings in the editor' },
];

/** Respond to a `requestCompletions` message from the webview. */
export async function handleCompletions(
  kind: 'slash' | 'file',
  queryText: string,
  post: (msg: HostToWebview) => void,
): Promise<void> {
  if (kind === 'slash') {
    post({ type: 'completions', kind: 'slash', items: slashCompletions(queryText) });
    return;
  }
  const items = await fileCompletions(queryText);
  post({ type: 'completions', kind: 'file', items });
}

function slashCompletions(queryText: string): CompletionItem[] {
  // The trailing space is load-bearing and deliberately NOT trimmed. It is what
  // separates a command the user has finished typing from one still being
  // matched: `/compact ` stops matching (they're about to type its argument, so
  // the popup gets out of the way and Enter submits), while `/switch ` still
  // matches the alias "switch model" and keeps the list open.
  const q = queryText.replace(/^\//, '').replace(/\s+/g, ' ').toLowerCase();
  if (q !== '' && q.trim() === '') return [];

  return SLASH_COMMANDS.filter((c) => rank(c, q) < MISS)
    .sort((a, b) => rank(a, q) - rank(b, q))
    .map((c) => ({
      label: c.argHint ? `${c.name} ${c.argHint}` : c.name,
      insert: `${c.name} `,
      detail: c.description,
      kind: 'command' as const,
    }));
}

const MISS = 9;

/**
 * The command name ranks above its aliases, and a prefix above a substring;
 * ties keep the palette's alphabetical order (`Array.sort` is stable). `MISS`
 * means no match at all — the filter above drops it.
 */
function rank(cmd: SlashCommand, q: string): number {
  const name = cmd.name.slice(1).toLowerCase();
  if (name.startsWith(q)) return 0;

  const aliases = (cmd.aliases ?? []).map((a) => a.toLowerCase());
  if (aliases.some((a) => a.startsWith(q))) return 1;
  if (name.includes(q)) return 2;
  if (aliases.some((a) => a.includes(q))) return 3;
  return MISS;
}

/**
 * Files *and* folders matching the `@` query. Folders are shown so the user can
 * drill into one (picking it rewrites the query as `dir/`, listing its
 * contents); both label and detail carry a trailing `/` so a folder never reads
 * like a file.
 */
async function fileCompletions(queryText: string): Promise<CompletionItem[]> {
  const q = queryText.replace(/^@/, '').trim();
  const glob = q ? `**/*${q}*` : '**/*';
  // findFiles respects .gitignore via the default search excludes.
  const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', 400);
  const root = getWorkspaceRoot();
  const files = uris.map((uri) => relPath(root, uri.fsPath));

  // `findFiles` only ever returns files, so derive the folders from the matched
  // files' ancestors — keeping just the ancestors that match the query too, or
  // every file would drag its whole chain of parents into the list.
  const needle = q.toLowerCase();
  const dirs = new Set<string>();
  for (const rel of files) {
    const segments = rel.split('/');
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      if (dir.toLowerCase().includes(needle)) dirs.add(dir);
    }
  }

  const entries = [
    ...[...dirs].map((rel) => ({ rel, isDir: true })),
    ...files.map((rel) => ({ rel, isDir: false })),
  ];
  return entries
    .sort((a, b) => a.rel.length - b.rel.length)
    .slice(0, 25)
    .map(({ rel, isDir }) => {
      // Lead with the name and trail with the containing folder, so two files
      // that share a name stay distinguishable. Root-level entries show no
      // containing folder.
      const slash = rel.lastIndexOf('/');
      const name = slash === -1 ? rel : rel.slice(slash + 1);
      return {
        label: isDir ? `${name}/` : name,
        // A folder inserts no trailing space: the caret lands after the `/` so
        // the next keystroke keeps filtering inside it.
        insert: isDir ? `@${rel}/` : `@${rel} `,
        detail: slash === -1 ? undefined : `${rel.slice(0, slash)}/`,
        kind: isDir ? 'directory' : 'file',
      } satisfies CompletionItem;
    });
}
