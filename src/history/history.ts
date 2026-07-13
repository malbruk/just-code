import { loadSdk } from '../agent/sdk';
import type { Attachment, ChatMessage, ContentBlock, HistoryEntry, ToolUseView } from '@just-code/core';
import { getWorkspaceRoot } from '../agent/config';
import { toolTitle, truncate, resultToText } from '../util/text';
import type { Logger } from '../util/logger';

let idCounter = 0;
function id(prefix: string): string {
  return `${prefix}-h${idCounter++}`;
}

/** List saved conversations for the current workspace. */
export async function listHistory(log: Logger): Promise<HistoryEntry[]> {
  try {
    const dir = getWorkspaceRoot();
    const { listSessions } = await loadSdk();
    const sessions = await listSessions({ dir, limit: 100, includeProgrammatic: true });
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || 'Untitled conversation',
      updatedAt: s.lastModified,
      messageCount: 0,
    }));
  } catch (err) {
    log.warn('listHistory failed', err);
    return [];
  }
}

/**
 * Permanently delete a saved conversation.
 *
 * This is not extension-local bookkeeping: the SDK removes `{sessionId}.jsonl`
 * and the `{sessionId}/` subagent-transcript directory from the shared Claude
 * projects dir (`~/.claude/projects/<encoded-cwd>/`). The transcript therefore
 * also disappears from `claude --resume` in the terminal, and the stored title
 * goes with it. There is no undo, so callers must confirm first.
 *
 * Throws when the session file doesn't exist.
 */
export async function deleteHistorySession(sessionId: string, log: Logger): Promise<void> {
  const { deleteSession } = await loadSdk();
  await deleteSession(sessionId, { dir: getWorkspaceRoot() });
  log.info(`Deleted session ${sessionId}`);
}

/** Load a past session and map it into `ChatMessage[]` for a fresh `init`. */
export async function loadSessionMessages(sessionId: string, root: string | undefined, log: Logger): Promise<ChatMessage[]> {
  const { getSessionMessages } = await loadSdk();
  const raw = await getSessionMessages(sessionId, { dir: root });
  const messages: ChatMessage[] = [];
  // Map tool_use id -> its view so tool_results can be attached.
  const toolViews = new Map<string, ToolUseView>();

  for (const entry of raw) {
    if (entry.type === 'assistant') {
      const beta = entry.message as { content?: Array<Record<string, unknown>> };
      const blocks = mapAssistantBlocks(beta.content ?? [], toolViews, root);
      if (blocks.length) {
        messages.push({ id: id('a'), role: 'assistant', blocks, createdAt: Date.now() });
      }
    } else if (entry.type === 'user') {
      const param = entry.message as { content?: unknown };
      const content = param.content;
      if (typeof content === 'string') {
        pushUserMessage(content, messages);
      } else if (Array.isArray(content)) {
        applyUserBlocks(content as Array<Record<string, unknown>>, toolViews, messages);
      }
    }
  }
  log.info(`Loaded ${messages.length} messages from session ${sessionId}`);
  return messages;
}

function mapAssistantBlocks(
  content: Array<Record<string, unknown>>,
  toolViews: Map<string, ToolUseView>,
  root: string | undefined,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    const type = block['type'];
    if (type === 'text' && typeof block['text'] === 'string') {
      blocks.push({ type: 'text', text: block['text'] as string });
    } else if (type === 'thinking' && typeof block['thinking'] === 'string') {
      blocks.push({ type: 'thinking', text: block['thinking'] as string });
    } else if (type === 'tool_use') {
      const toolId = String(block['id'] ?? id('tool'));
      const name = String(block['name'] ?? 'Tool');
      const input = (block['input'] as Record<string, unknown>) ?? {};
      const view: ToolUseView = {
        id: toolId,
        name,
        input,
        status: 'success',
        title: toolTitle(name, input, root),
      };
      toolViews.set(toolId, view);
      blocks.push({ type: 'tool_use', toolUse: view });
    }
  }
  return blocks;
}

function applyUserBlocks(
  content: Array<Record<string, unknown>>,
  toolViews: Map<string, ToolUseView>,
  messages: ChatMessage[],
): void {
  const textParts: string[] = [];
  for (const block of content) {
    if (block['type'] === 'tool_result') {
      const toolUseId = String(block['tool_use_id'] ?? '');
      const view = toolViews.get(toolUseId);
      if (view) {
        view.status = block['is_error'] === true ? 'error' : 'success';
        view.resultText = truncate(resultToText(block['content']));
      }
    } else if (block['type'] === 'text' && typeof block['text'] === 'string') {
      textParts.push(block['text'] as string);
    }
  }
  if (textParts.length) pushUserMessage(textParts.join('\n'), messages);
}

/**
 * Reconstruct one user message: strip host-injected context, lift any leading
 * attached-file code fences back into attachment chips, and keep only the text
 * the user actually typed.
 */
function pushUserMessage(raw: string, messages: ChatMessage[]): void {
  const { text, attachments } = parseUserContent(raw);
  if (!text && !attachments.length) return;
  messages.push({
    id: id('u'),
    role: 'user',
    blocks: text ? [{ type: 'text', text }] : [],
    attachments: attachments.length ? attachments : undefined,
    createdAt: Date.now(),
  });
}

interface ParsedUserContent {
  text: string;
  attachments: Attachment[];
}

/**
 * A submitted prompt has any `@`-mentioned/added files expanded into leading
 * fenced code blocks (` ```<path>\n…\n``` `) ahead of the typed text (see
 * `SessionManager.attachmentToBlock`). When replaying history we don't want the
 * whole file content dumped into the transcript — just a chip. This pulls those
 * leading fences back out into `Attachment`s and returns the remaining text.
 */
function parseUserContent(raw: string): ParsedUserContent {
  let rest = cleanUserText(raw);
  const attachments: Attachment[] = [];
  // A leading fenced block: ```<info>\n<body>\n``` optionally trailed by blanks.
  const fence = /^```([^\n]*)\n[\s\S]*?\n```[ \t]*(?:\n+|$)/;

  for (;;) {
    rest = rest.replace(/^\s+/, '');
    const m = fence.exec(rest);
    if (!m) break;
    const info = m[1].trim();
    if (!looksLikePath(info)) break; // a real code block the user wrote — keep it
    attachments.push(fenceToAttachment(info));
    rest = rest.slice(m[0].length);
  }

  return { text: rest.trim(), attachments };
}

/** True when a code-fence info string is a file path rather than a language. */
function looksLikePath(info: string): boolean {
  const path = info.replace(/ \(lines \d+-\d+\)$/, '');
  return /[\\/]/.test(path) || /\.[A-Za-z0-9]+$/.test(path);
}

/** Turn an attachment fence's info string into an `Attachment` chip. */
function fenceToAttachment(info: string): Attachment {
  const sel = info.match(/^(.+?) \(lines (\d+)-(\d+)\)$/);
  if (sel) {
    const path = sel[1];
    const startLine = Number(sel[2]);
    const endLine = Number(sel[3]);
    return {
      kind: 'selection',
      path,
      label: `${basename(path)}:${startLine}-${endLine}`,
      range: { startLine, endLine },
    };
  }
  return { kind: 'file', path: info, label: basename(info) };
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/**
 * Strip host-injected context wrappers from a stored user message so the
 * reconstructed transcript shows what the user actually typed, not the IDE
 * context / command plumbing the extension folds into each turn.
 */
function cleanUserText(raw: string): string {
  return raw
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim();
}
