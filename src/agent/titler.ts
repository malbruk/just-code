import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSdk } from './sdk';
import type { Logger } from '../util/logger';

/** Cheapest model — a title is a one-sentence summarization job. */
const TITLE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_PROMPT_CHARS = 2000;
const MAX_TITLE_CHARS = 60;
const TIMEOUT_MS = 15_000;

/**
 * A scratch cwd for the titling query.
 *
 * `query()` always records a session transcript, keyed by its `cwd`. Titling
 * inside the workspace would therefore add a junk conversation to the user's
 * history list on every new chat, so it runs against a throwaway directory.
 */
const TITLER_CWD = path.join(os.tmpdir(), 'yes-code-titler');

export interface TitlerDeps {
  env: Record<string, string>;
  binary: string;
  log: Logger;
}

/**
 * Ask a small model for a short title describing the user's first message.
 *
 * We generate this ourselves rather than reusing the title the native binary
 * writes into the transcript: that one summarizes the *whole* first message,
 * which for this extension begins with the full contents of every attached
 * file (the active-editor chip is attached automatically). The result reads as
 * a title for whatever file happened to be open — "Review agent system prompt
 * guidelines" — instead of for the question that was asked. Passing only the
 * text the user typed keeps the title about the conversation.
 *
 * Resolves `undefined` on any failure; a title is never worth failing a turn.
 */
export async function generateTitle(prompt: string, deps: TitlerDeps): Promise<string | undefined> {
  const text = prompt.trim().slice(0, MAX_PROMPT_CHARS);
  if (!text) return undefined;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  try {
    // The binary is spawned with this cwd; a missing directory fails the spawn,
    // which the SDK reports as an unrelated "binary failed to launch" error.
    fs.mkdirSync(TITLER_CWD, { recursive: true });
    const { query } = await loadSdk();
    const q = query({
      prompt: instruction(text),
      options: {
        cwd: TITLER_CWD,
        model: TITLE_MODEL,
        pathToClaudeCodeExecutable: deps.binary,
        env: deps.env,
        abortController,
        // A pure text task: no tools, no CLAUDE.md, no MCP servers, no thinking,
        // and no nested title generation for the titling session itself.
        systemPrompt: 'You write short, specific titles for developer conversations.',
        settingSources: [],
        allowedTools: [],
        maxTurns: 1,
        thinking: { type: 'disabled' },
        title: 'Yes Code title generation',
      },
    });

    let out = '';
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        const content = (msg.message as { content?: Array<Record<string, unknown>> }).content ?? [];
        for (const block of content) {
          if (block['type'] === 'text' && typeof block['text'] === 'string') out += block['text'];
        }
      } else if (msg.type === 'result') {
        break;
      }
    }
    return sanitize(out);
  } catch (err) {
    deps.log.warn('generateTitle failed', err);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function instruction(text: string): string {
  return (
    'Write a title for a conversation that opens with the message below. ' +
    'At most six words. Name the specific subject rather than the kind of request — ' +
    'prefer "Fable 5 missing from model list" over "Question about a model". ' +
    'Write it in the same language as the message. ' +
    'Reply with the title alone: no quotes, no trailing period, no preamble.\n\n' +
    `<message>\n${text}\n</message>`
  );
}

/** Reduce a model reply to a single clean title line. */
function sanitize(raw: string): string | undefined {
  let title = raw.trim().split('\n')[0]?.trim() ?? '';
  // Models sometimes wrap the answer despite being told not to.
  title = title.replace(/^["'`«»]+|["'`«»]+$/g, '').trim();
  title = title.replace(/[.]+$/, '').trim();
  if (!title) return undefined;
  if (title.length > MAX_TITLE_CHARS) title = `${title.slice(0, MAX_TITLE_CHARS).trimEnd()}…`;
  return title;
}
