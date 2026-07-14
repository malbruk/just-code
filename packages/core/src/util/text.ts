import * as path from 'path';
import { LOAD_INSTRUCTIONS_TOOL } from '../protocol.js';

/** Truncate text for display, appending an ellipsis note when clipped. */
export function truncate(text: string, max = 4000): string {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max);
  const omitted = text.length - max;
  return `${clipped}\n… (${omitted} more characters truncated)`;
}

/** Make a path workspace-relative for display, if it lives under root. */
export function relPath(root: string | undefined, p: string): string {
  if (!p) return p;
  if (!root) return p;
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return rel.split(path.sep).join('/');
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' ? v : undefined;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === 'number' ? v : undefined;
}

/** One-line collapse of a (possibly multi-line) command for a title. */
function oneLine(s: string, max = 80): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * Build a human-friendly one-line title for a tool invocation, e.g.
 * "Read `src/index.ts`", "Edit `foo.ts`", "Bash: `npm test`", "Grep `TODO`".
 */
export function toolTitle(name: string, input: Record<string, unknown>, root?: string): string {
  const fileKeys = ['file_path', 'path', 'notebook_path'];
  const filePath = fileKeys.map((k) => str(input, k)).find((v) => !!v);
  const rel = filePath ? relPath(root, filePath) : undefined;

  switch (name) {
    case 'Read': {
      const offset = num(input, 'offset');
      const limit = num(input, 'limit');
      let suffix = '';
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 0;
        suffix = limit !== undefined ? ` (lines ${start}–${start + limit})` : ` (from line ${start})`;
      }
      return `Read \`${rel ?? '?'}\`${suffix}`;
    }
    case 'Write':
      return `Write \`${rel ?? '?'}\``;
    case 'Edit':
      return `Edit \`${rel ?? '?'}\``;
    case 'MultiEdit': {
      const edits = input['edits'];
      const count = Array.isArray(edits) ? edits.length : 0;
      return `Edit \`${rel ?? '?'}\`${count ? ` (${count} changes)` : ''}`;
    }
    case 'NotebookEdit':
      return `Edit notebook \`${rel ?? '?'}\``;
    case 'Bash': {
      const cmd = str(input, 'command') ?? '';
      return `Bash: \`${oneLine(cmd)}\``;
    }
    case 'BashOutput':
      return 'Read background shell output';
    case 'KillShell':
      return 'Kill background shell';
    case 'Grep': {
      const pattern = str(input, 'pattern') ?? '';
      const inPath = str(input, 'path');
      return `Grep \`${oneLine(pattern, 60)}\`${inPath ? ` in \`${relPath(root, inPath)}\`` : ''}`;
    }
    case 'Glob': {
      const pattern = str(input, 'pattern') ?? '';
      return `Glob \`${oneLine(pattern, 60)}\``;
    }
    case 'LS':
      return `List \`${rel ?? str(input, 'path') ?? '.'}\``;
    case 'WebFetch': {
      const url = str(input, 'url') ?? '';
      return `Fetch ${oneLine(url, 60)}`;
    }
    case 'WebSearch': {
      const q = str(input, 'query') ?? '';
      return `Search: ${oneLine(q, 60)}`;
    }
    case 'TodoWrite':
      return 'Update todo list';
    case 'Task': {
      const desc = str(input, 'description') ?? str(input, 'subagent_type') ?? '';
      return `Task: ${oneLine(desc, 60)}`;
    }
    case 'AskUserQuestion': {
      const questions = input['questions'];
      if (!Array.isArray(questions) || questions.length === 0) return 'Ask a question';
      const first = questions[0] as Record<string, unknown>;
      const text = str(first, 'question') ?? '';
      const more = questions.length - 1;
      return `Ask: ${oneLine(text, 60)}${more > 0 ? ` (+${more} more)` : ''}`;
    }
    case LOAD_INSTRUCTIONS_TOOL: {
      const profile = str(input, 'profile');
      return profile ? `Loading \`${profile}\`` : 'Loading instructions';
    }
    case 'Skill': {
      const skill = str(input, 'skill');
      if (!skill) return name;
      const args = str(input, 'args');
      return `Skill: \`${skill}\`${args ? ` ${oneLine(args, 60)}` : ''}`;
    }
    default:
      return rel ? `${name} \`${rel}\`` : name;
  }
}

/** Coerce arbitrary tool_result content into display text. */
export function resultToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (typeof b['text'] === 'string') return b['text'];
          if (b['type'] === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
