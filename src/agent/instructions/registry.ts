import * as fs from 'fs';
import * as path from 'path';

/**
 * Registry of work profiles and their on-demand instruction prompts.
 *
 * Two layers:
 *
 * - **Profile** — a work domain (coding, accounting, graphics, …). Exactly one
 *   profile is in effect at a time (`just-code.activeProfile`); its system
 *   prompt is appended to the preset system prompt of every new session.
 * - **Prompt** — an on-demand instruction set under a profile. The base system
 *   prompt is deliberately short; instruction sets that are long and only
 *   needed for specific kinds of requests live here instead. The model signals
 *   a matching request by calling the `load_instructions` tool of the
 *   in-process MCP server (`server.ts`); the extension then asks the user to
 *   activate the prompt and, on approval, re-anchors the session (query
 *   restart + `resume`) with the prompt's full text inlined in the *system
 *   prompt* and re-runs the request. The text is never delivered through a
 *   tool result — tool results are an untrusted channel, and models correctly
 *   dismiss "binding instructions" arriving there as prompt injection.
 *
 * Everything is loaded generically from `prompts/profiles/**` (copied into
 * `dist/prompts/` by `esbuild.js`), SKILL.md-style:
 *
 * ```
 * prompts/profiles/
 *   <profile-id>/
 *     profile.md      ← YAML frontmatter (name, description) + body = the
 *                        profile's system prompt
 *     <prompt-id>.md  ← YAML frontmatter (name, description) + body = the
 *                        prompt's full instruction text
 * ```
 *
 * Adding a profile or a prompt is a pure content change — drop the `.md` in
 * place and rebuild; no code needs to change. The frontmatter `description`
 * states what requests/tasks the prompt applies to: it is the single source of
 * truth for routing, composed into both the system prompt's prompt list
 * (`../systemPrompt.ts`) and the tool description (`server.ts`).
 */

/** Frontmatter identity shared by profiles and prompts. */
export interface PromptMeta {
  /** Stable id — the file/directory basename; used in settings keys and the signal tool. */
  id: string;
  /** Human-readable display name (frontmatter `name`; falls back to the id). */
  name: string;
  /**
   * What the prompt applies to (frontmatter `description`). For a prompt this
   * drives routing — the model loads the prompt when the request matches — and
   * may carry pre-load guidance (e.g. "do not refuse such a task"). For a
   * profile it is shown in the `/instructions` dialog.
   */
  description: string;
}

/** One on-demand instruction prompt (a `.md` under a profile directory). */
export interface InstructionPrompt extends PromptMeta {
  /** The full instruction text (the file body) injected into the system prompt. */
  text: string;
}

/** One work profile (a directory with a `profile.md` + prompt files). */
export interface WorkProfile extends PromptMeta {
  /** The profile's system prompt (the `profile.md` body). */
  systemPrompt: string;
  prompts: Record<string, InstructionPrompt>;
  /** Prompt ids in deterministic (sorted) order. */
  promptIds: string[];
}

/**
 * Parse a SKILL.md-style YAML frontmatter block. Supports the subset the
 * registry needs: single-line `key: value` scalars (optionally quoted) and
 * folded/literal block scalars (`>`, `>-`, `|`, `|-`) whose indented
 * continuation lines are joined by a space (folded) or newline (literal).
 * A file without a frontmatter block yields empty meta and the whole file as
 * body. Exported for tests.
 */
export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const normalized = src.replace(/^﻿/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { meta: {}, body: normalized.trim() };

  const meta: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') break;
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    if (/^[>|]-?$/.test(value)) {
      // Block scalar: consume the following more-indented lines.
      const fold = value.startsWith('>');
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) {
        if (lines[i + 1]!.trim() === '---') break;
        parts.push(lines[++i]!.trim());
      }
      value = parts.filter((p) => p !== '').join(fold ? ' ' : '\n');
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  const body = lines.slice(i + 1).join('\n').trim();
  return { meta, body };
}

/**
 * Where the profile directories live. In the shipped bundle (CJS) `__dirname`
 * is `dist/`, and `esbuild.js` copies `src/agent/prompts/profiles/**` to
 * `dist/prompts/profiles/**`, so the default resolves in production, in the
 * F5 dev host, and in the VSIX alike. Resolved lazily because ESM test
 * bundles have no `__dirname` — they point elsewhere via `setProfilesRoot`.
 */
function defaultRoot(): string {
  if (process.env['JUST_CODE_PROFILES_ROOT']) return process.env['JUST_CODE_PROFILES_ROOT'];
  return typeof __dirname !== 'undefined'
    ? path.join(__dirname, 'prompts', 'profiles')
    : path.join(process.cwd(), 'dist', 'prompts', 'profiles');
}

let profilesRoot: string | undefined;
let cache: Record<string, WorkProfile> | undefined;

/** Point the registry at a different profiles directory (tests) and drop the cache. */
export function setProfilesRoot(dir: string): void {
  profilesRoot = dir;
  cache = undefined;
}

function readEntry(file: string, id: string): PromptMeta & { body: string } {
  const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  return { id, name: meta['name'] || id, description: meta['description'] ?? '', body };
}

/**
 * Load (and cache) every profile under the profiles root. A missing root or an
 * unreadable entry degrades to "not there" rather than throwing — the
 * extension must still activate when the content directory is absent.
 */
export function loadProfiles(): Record<string, WorkProfile> {
  if (cache) return cache;
  const root = profilesRoot ?? defaultRoot();
  const profiles: Record<string, WorkProfile> = {};
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // No profiles directory — an empty registry.
  }
  for (const dir of dirs) {
    try {
      const profileFile = path.join(root, dir, 'profile.md');
      const p = readEntry(profileFile, dir);
      const prompts: Record<string, InstructionPrompt> = {};
      const promptIds = fs
        .readdirSync(path.join(root, dir))
        .filter((f) => f.endsWith('.md') && f !== 'profile.md')
        .map((f) => f.slice(0, -3))
        .sort();
      for (const promptId of promptIds) {
        const e = readEntry(path.join(root, dir, `${promptId}.md`), promptId);
        prompts[promptId] = { id: e.id, name: e.name, description: e.description, text: e.body };
      }
      profiles[dir] = { id: p.id, name: p.name, description: p.description, systemPrompt: p.body, prompts, promptIds };
    } catch (err) {
      console.warn(`[just-code] Skipping malformed work profile "${dir}":`, err);
    }
  }
  cache = profiles;
  return profiles;
}

/** Profile ids in deterministic (sorted) order. */
export function profileIds(): string[] {
  return Object.keys(loadProfiles());
}

/** Look up a work profile by id. */
export function getWorkProfile(id: string): WorkProfile | undefined {
  return loadProfiles()[id];
}

/** Look up an instruction prompt within a profile. */
export function getPrompt(profileId: string, promptId: string): InstructionPrompt | undefined {
  return loadProfiles()[profileId]?.prompts[promptId];
}

/**
 * The settings key for a prompt: prompt ids are only unique within their
 * profile, so `just-code.instructionPrompts` / `just-code.autoActivatePrompts`
 * store them scoped as `<profile-id>/<prompt-id>`.
 */
export function promptKey(profileId: string, promptId: string): string {
  return `${profileId}/${promptId}`;
}

/**
 * Frame a prompt's full text for inlining into the system prompt once the
 * user has activated it. The frame only *labels* the block — it does not need
 * to claim authority, because it already lives in the system prompt (the
 * activation flow re-anchors the session via resume; see `sessionManager.ts`).
 */
export function frameActive(prompt: InstructionPrompt): string {
  return `=== INSTRUCTION PROMPT "${prompt.id}" ===\n\n${prompt.text}`;
}
