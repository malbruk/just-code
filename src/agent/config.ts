import * as vscode from 'vscode';
import type { CanUseTool, McpSdkServerConfigWithInstance, Options, ThinkingConfig } from '@just-code/core/agent/sdk.js';
import type { AuthMethod, EffortLevel, InstructionsMode, ModelId, PermissionMode } from '@just-code/core';
import { INSTRUCTIONS_SERVER_NAME } from '@just-code/core';
import { installHint, resolveClaudeBinary } from './cli';
import { getWorkProfile, promptKey, type InstructionPrompt, type WorkProfile } from './instructions/registry';
import { buildSystemPromptAppend } from './systemPrompt';

const SECRET_KEY = 'just-code.apiKey';

/** Thrown by {@link buildOptions} when no Claude Code installation can be found. */
export class ClaudeRuntimeNotFoundError extends Error {
  constructor() {
    super(installHint());
    this.name = 'ClaudeRuntimeNotFoundError';
  }
}

/** User-configurable settings read from the `just-code.*` configuration. */
export interface HostConfig {
  model: ModelId;
  permissionMode: PermissionMode;
  authMethod: AuthMethod;
  maxTurns: number;
  thinkingBudget: number;
  /** Reasoning effort level; `default` leaves the model default in place. */
  effort: EffortLevel;
  /** Whether extended thinking is enabled. */
  extendedThinking: boolean;
  /** Whether to set a fallback model (used when the primary is flagged/fails). */
  autoModelFallback: boolean;
  additionalDirectories: string[];
  loadProjectSettings: boolean;
  /** Extension-wide instruction source: base only, or the active work profile. */
  instructionsMode: InstructionsMode;
  /**
   * The selected work profile's id (`just-code.activeProfile`). Exactly one
   * profile is in effect at a time; its system prompt is appended to every
   * new session in `profiles` mode. May name a profile this build does not
   * ship — then it resolves to no profile at all.
   */
  activeProfile: string;
  /**
   * The instruction prompts in effect for new sessions: every prompt of the
   * active profile not switched off in `just-code.instructionPrompts`, or
   * empty in `base` mode. Empty ⇒ no prompts section in the system prompt and
   * no `load_instructions` server.
   */
  enabledPrompts: string[];
}

/**
 * Resolve the work profile a session runs under: the selected profile in
 * `profiles` mode, none in `base` mode (or when the id is unknown).
 */
export function resolveProfile(mode: InstructionsMode, activeProfile: string): WorkProfile | undefined {
  return mode === 'profiles' ? getWorkProfile(activeProfile) : undefined;
}

/**
 * Compute the enabled-prompt set from the instruction settings: every prompt
 * of the active profile whose `<profile>/<prompt>` entry in the per-prompt map
 * is not `false` (missing means enabled, so new prompts are on by default);
 * none in `base` mode.
 */
export function enabledPromptsFrom(mode: InstructionsMode, activeProfile: string, promptMap: Record<string, boolean>): string[] {
  const profile = resolveProfile(mode, activeProfile);
  if (!profile) return [];
  return profile.promptIds.filter((id) => promptMap[promptKey(profile.id, id)] !== false);
}

/**
 * Split the enabled prompts for a session: `active` = activated for this
 * conversation (full text inlined in the system prompt), `advertised` = the
 * rest (offered for routing via the signal tool). A prompt disabled in
 * settings is dropped from both, even if it was activated earlier.
 */
export function splitPrompts(
  enabled: readonly string[],
  activated: readonly string[],
): { advertised: string[]; active: string[] } {
  const active = activated.filter((p) => enabled.includes(p));
  return { advertised: enabled.filter((p) => !active.includes(p)), active };
}

/** Read the current `just-code.*` settings snapshot. */
export function readConfig(): HostConfig {
  const cfg = vscode.workspace.getConfiguration('just-code');
  const instructionsMode = cfg.get<InstructionsMode>('instructionsMode', 'profiles');
  const activeProfile = cfg.get<string>('activeProfile', 'coding');
  return {
    model: cfg.get<ModelId>('model', 'default'),
    permissionMode: cfg.get<PermissionMode>('permissionMode', 'default'),
    authMethod: cfg.get<AuthMethod>('authMethod', 'subscription'),
    maxTurns: cfg.get<number>('maxTurns', 100),
    thinkingBudget: cfg.get<number>('thinkingBudget', 0),
    effort: cfg.get<EffortLevel>('effort', 'default'),
    extendedThinking: cfg.get<boolean>('extendedThinking', true),
    autoModelFallback: cfg.get<boolean>('autoModelFallback', false),
    additionalDirectories: cfg.get<string[]>('additionalDirectories', []),
    loadProjectSettings: cfg.get<boolean>('loadProjectSettings', true),
    instructionsMode,
    activeProfile,
    enabledPrompts: enabledPromptsFrom(instructionsMode, activeProfile, cfg.get<Record<string, boolean>>('instructionPrompts', {})),
  };
}

/** The absolute path of the primary workspace folder, if any. */
export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Resolve the Anthropic API key, preferring (in order):
 *   1. VS Code SecretStorage
 *   2. the `just-code.apiKey` setting
 *   3. the ambient `ANTHROPIC_API_KEY` environment variable
 */
export async function resolveApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const fromSecret = await context.secrets.get(SECRET_KEY);
  if (fromSecret) return fromSecret;

  const fromSetting = vscode.workspace.getConfiguration('just-code').get<string>('apiKey', '');
  if (fromSetting && fromSetting.trim()) return fromSetting.trim();

  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  return undefined;
}

/** Persist an API key into SecretStorage. */
export async function storeApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store(SECRET_KEY, key.trim());
}

/** Remove the stored API key. */
export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
}

export interface BuildOptionsArgs {
  config: HostConfig;
  /** The auth method in effect for this session. */
  authMethod: AuthMethod;
  /** Only used when `authMethod === 'apiKey'`. */
  apiKey?: string;
  model: ModelId;
  permissionMode: PermissionMode;
  /** Live reasoning-effort selection (overrides `config.effort`). */
  effort: EffortLevel;
  /** Live extended-thinking toggle (overrides `config.extendedThinking`). */
  extendedThinking: boolean;
  /** Live fallback-model toggle (overrides `config.autoModelFallback`). */
  autoModelFallback: boolean;
  canUseTool: CanUseTool;
  /**
   * The per-session instruction-prompts server (see `instructions/`).
   * Absent when no prompt is advertised — then `load_instructions` simply
   * does not exist for the session.
   */
  instructionsServer?: McpSdkServerConfigWithInstance;
  /**
   * Instruction prompts the user activated for this conversation: their full
   * text is inlined into the system-prompt append, and they are excluded from
   * the advertised (routing) list.
   */
  activePrompts: string[];
  abortController: AbortController;
  resume?: string;
  log: (data: string) => void;
}

/** Pick a sensible fallback model for the "switch when flagged" feature. */
function fallbackFor(model: ModelId): string {
  // Fall back to a broadly-available, capable model that differs from the
  // primary; Opus falls back to Sonnet, everything else falls back to Opus.
  return model === 'claude-opus-4-8' ? 'claude-sonnet-5' : 'claude-opus-4-8';
}

/**
 * Build the environment for a spawned `claude` process.
 *
 * `env` REPLACES the subprocess environment rather than extending it, so
 * `process.env` is spread in explicitly.
 */
export function buildEnv(authMethod: AuthMethod, apiKey?: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (authMethod === 'apiKey' && apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
  } else {
    // Subscription mode: never let an ambient API key override the stored
    // claude.ai OAuth credentials the native binary was logged in with.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'justcode/1.0.0';
  return env;
}

/** Assemble the SDK `Options` for a `query()` call. */
export function buildOptions(args: BuildOptionsArgs): Options {
  const { config, authMethod, apiKey, model, permissionMode, effort, extendedThinking, autoModelFallback, canUseTool, instructionsServer, activePrompts, abortController, resume, log } = args;
  const root = getWorkspaceRoot();
  const env = buildEnv(authMethod, apiKey);
  const profile = resolveProfile(config.instructionsMode, config.activeProfile);
  const { advertised, active } = splitPrompts(config.enabledPrompts, activePrompts);
  // `enabledPrompts` was derived from the same registry, so the lookups hold;
  // dropping a miss beats crashing session start on a stale settings entry.
  const resolve = (ids: string[]) =>
    ids.map((id) => profile?.prompts[id]).filter((p): p is InstructionPrompt => p !== undefined);
  const append = buildSystemPromptAppend(profile, resolve(advertised), resolve(active));

  const options: Options = {
    cwd: root,
    systemPrompt: append
      ? { type: 'preset', preset: 'claude_code', append }
      : { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    // The extension's own in-process server (on-demand instruction prompts),
    // absent when no profile is enabled. This map is separate from the
    // `.mcp.json` / settings-file servers, which arrive via `settingSources`
    // below — it does not override them.
    mcpServers: instructionsServer ? { [INSTRUCTIONS_SERVER_NAME]: instructionsServer } : {},
    // All three sources, not just 'project'. `user` (~/.claude/settings.json)
    // is where globally-configured MCP servers live — with only `project` they
    // are silently missing. `local` (.claude/settings.local.json) holds the
    // per-machine project overrides.
    //
    // Note this also loads the workspace `.mcp.json`, and the SDK connects those
    // servers without an approval prompt (unlike the interactive CLI). That is
    // arbitrary command execution from the repository, which is why the
    // extension declares `untrustedWorkspaces: false` in package.json.
    settingSources: config.loadProjectSettings ? ['user', 'project', 'local'] : [],
    permissionMode,
    canUseTool,
    includePartialMessages: true,
    maxTurns: config.maxTurns,
    model: model === 'default' ? undefined : model,
    abortController,
    additionalDirectories: config.additionalDirectories,
    // Track file changes so turns can be rewound (SDK `Query.rewindFiles`).
    enableFileCheckpointing: true,
    env,
    stderr: log,
  };

  // Reasoning effort (SDK default is `high` when unset).
  if (effort !== 'default') options.effort = effort;

  // Fall back to another model when the primary is flagged / fails.
  if (autoModelFallback) options.fallbackModel = fallbackFor(model);

  // Pin the executable to the binary we auth-check against, so the SDK and our
  // `claude auth` calls always agree on which runtime/credentials are in use.
  //
  // This is required, not optional: we do not ship the native runtime, so if we
  // leave `pathToClaudeCodeExecutable` unset the SDK falls back to resolving a
  // per-platform package that is absent from the VSIX, and throws
  //   "Native CLI binary for <plat> not found. Reinstall @anthropic-ai/claude-agent-sdk
  //    without --omit=optional…"
  // — advice that makes no sense to someone who installed a VS Code extension.
  // Fail here instead, with something the user can act on.
  const bin = resolveClaudeBinary();
  if (!bin) throw new ClaudeRuntimeNotFoundError();
  options.pathToClaudeCodeExecutable = bin;

  // Extended thinking: off → disabled; on with an explicit budget → enabled at
  // that budget; on without a budget → leave the model default (adaptive).
  if (!extendedThinking) {
    options.thinking = { type: 'disabled' } satisfies ThinkingConfig;
  } else if (config.thinkingBudget && config.thinkingBudget > 0) {
    options.thinking = { type: 'enabled', budgetTokens: config.thinkingBudget } satisfies ThinkingConfig;
  }

  if (resume) options.resume = resume;

  return options;
}
