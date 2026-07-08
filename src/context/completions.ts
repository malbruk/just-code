import * as vscode from 'vscode';
import type { CompletionItem, HostToWebview, SlashCommand } from '../shared/protocol';
import { getWorkspaceRoot } from '../agent/config';
import { relPath } from '../util/text';

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
  { name: '/config', description: 'Open the Green Code settings' },
  { name: '/cost', description: 'Show token usage and cost for this session' },
  { name: '/doctor', description: 'Check the health of your Green Code installation' },
  { name: '/help', description: 'Show help and the list of available commands' },
  { name: '/init', description: 'Initialize the project with a CLAUDE.md guide' },
  { name: '/login', description: 'Sign in with your Claude account or API key' },
  { name: '/logout', description: 'Sign out of your Claude account' },
  { name: '/mcp', description: 'Manage MCP server connections' },
  { name: '/memory', description: 'Edit the project CLAUDE.md memory file' },
  { name: '/model', description: 'Switch the active model', argHint: '[model]' },
  { name: '/new', description: 'Start a new chat' },
  { name: '/permissions', description: 'Change the tool permission mode', argHint: '[mode]' },
  { name: '/release-notes', description: 'Show what is new in Green Code' },
  { name: '/resume', description: 'Resume a previous conversation' },
  { name: '/review', description: 'Review the current changes or a pull request', argHint: '[target]' },
  { name: '/status', description: 'Show account, model, and workspace status' },
  { name: '/terminal-setup', description: 'Tips for using Claude Code in the terminal' },
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
  const q = queryText.replace(/^\//, '').toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.slice(1).toLowerCase().includes(q))
    .sort((a, b) => rank(a.name, q) - rank(b.name, q))
    .map((c) => ({
      label: c.argHint ? `${c.name} ${c.argHint}` : c.name,
      insert: `${c.name} `,
      detail: c.description,
    }));
}

/** Prefix matches rank above substring matches, then alphabetical. */
function rank(name: string, q: string): number {
  return name.slice(1).toLowerCase().startsWith(q) ? 0 : 1;
}

async function fileCompletions(queryText: string): Promise<CompletionItem[]> {
  const q = queryText.replace(/^@/, '').trim();
  const glob = q ? `**/*${q}*` : '**/*';
  // findFiles respects .gitignore via the default search excludes.
  const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', 50);
  const root = getWorkspaceRoot();
  return uris
    .map((uri) => {
      const rel = relPath(root, uri.fsPath);
      return { label: rel, insert: `@${rel} `, detail: 'File' } satisfies CompletionItem;
    })
    .sort((a, b) => a.label.length - b.label.length)
    .slice(0, 25);
}
