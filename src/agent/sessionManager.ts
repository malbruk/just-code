import * as vscode from 'vscode';
import * as path from 'path';
import type {
  Attachment,
  AuthInfo,
  AuthMethod,
  AuthStage,
  ChatMessage,
  EffortLevel,
  HostToWebview,
  ModelId,
  PermissionMode,
  UsageInfo,
  WebviewState,
  WebviewToHost,
} from '../shared/protocol';
import { MODELS } from '../shared/protocol';
import { AgentSession } from './session';
import {
  buildOptions,
  clearApiKey,
  getWorkspaceRoot,
  readConfig,
  resolveApiKey,
  storeApiKey,
} from './config';
import {
  clearBinaryCache,
  getAuthStatus,
  logout as cliLogout,
  installHint,
  resolveClaudeBinary,
  startLogin,
  type LoginSession,
} from './cli';
import { PermissionBridge } from '../tools/permissions';
import { PendingEditManager } from '../tools/diff';
import { EditorContextTracker } from '../context/editorContext';
import { handleCompletions, SLASH_COMMANDS } from '../context/completions';
import { listHistory, loadSessionMessages } from '../history/history';
import { Logger } from '../util/logger';

let userMsgSeq = 0;

/** Extensions treated as images for "Upload from computer" (carried as data URIs). */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

/**
 * The host-side brain. Owns the current {@link AgentSession}, the permission
 * bridge, pending-edit tracking, editor context, and translates every
 * `WebviewToHost` message into an action. Broadcasts `HostToWebview` messages
 * through an injected `post` function (the view provider fans it out to all
 * connected webviews).
 */
export class SessionManager implements vscode.Disposable {
  readonly edits = new PendingEditManager();
  readonly editorTracker: EditorContextTracker;
  private readonly permissions: PermissionBridge;

  private post: (msg: HostToWebview) => void = () => undefined;
  private reveal: () => void | Promise<void> = () => undefined;

  private session: AgentSession | undefined;
  // A session loaded from history is shown without spawning an agent process;
  // the resume id + transcript wait here and are adopted lazily when the user
  // sends the next turn (see ensureSession).
  private pendingResume: string | undefined;
  private pendingMessages: ChatMessage[] | undefined;
  private model: ModelId;
  private permissionMode: PermissionMode;
  private effort: EffortLevel;
  private extendedThinking: boolean;
  private autoModelFallback: boolean;
  private signedIn = false;
  private auth: AuthInfo = { signedIn: false };
  private usage: UsageInfo | undefined;
  private loginSession: LoginSession | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
  ) {
    const cfg = readConfig();
    this.model = cfg.model;
    this.permissionMode = cfg.permissionMode;
    this.effort = cfg.effort;
    this.extendedThinking = cfg.extendedThinking;
    this.autoModelFallback = cfg.autoModelFallback;
    this.permissions = new PermissionBridge((m) => this.post(m), log);
    this.permissions.setMode(this.permissionMode);
    this.editorTracker = new EditorContextTracker((m) => this.post(m));
    void this.refreshAuth();
  }

  /** Wire the broadcast + reveal callbacks provided by the view layer. */
  connect(post: (msg: HostToWebview) => void, reveal: () => void | Promise<void>): void {
    this.post = post;
    this.reveal = reveal;
  }

  // --- state ---------------------------------------------------------------

  getState(): WebviewState {
    return {
      messages: this.session?.messages ?? this.pendingMessages ?? [],
      model: this.model,
      permissionMode: this.permissionMode,
      effort: this.effort,
      extendedThinking: this.extendedThinking,
      autoModelFallback: this.autoModelFallback,
      busy: this.session?.isBusy() ?? false,
      editorContext: this.editorTracker.current(),
      usage: this.usage,
      signedIn: this.signedIn,
      auth: this.auth,
      slashCommands: SLASH_COMMANDS,
    };
  }

  private sendInit(): void {
    this.post({ type: 'init', state: this.getState() });
  }

  // --- webview message dispatch -------------------------------------------

  async handleMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.sendInit();
        return;
      case 'submit':
        await this.submit(msg.text, msg.attachments);
        return;
      case 'stop':
        await this.stop();
        return;
      case 'newChat':
        this.newChat();
        return;
      case 'permissionDecision':
        this.permissions.resolve(msg.id, msg.decision);
        return;
      case 'setModel':
        await this.setModel(msg.model);
        return;
      case 'setPermissionMode':
        await this.setPermissionMode(msg.mode);
        return;
      case 'setEffort':
        await this.setEffort(msg.effort);
        return;
      case 'setThinking':
        await this.setThinking(msg.enabled);
        return;
      case 'setModelFallback':
        await this.setModelFallback(msg.enabled);
        return;
      case 'editDecision':
        await this.decideEdit(msg.toolUseId, msg.accept);
        return;
      case 'acceptAllEdits':
        this.acceptAllEdits();
        return;
      case 'rejectAllEdits':
        await this.rejectAllEdits();
        return;
      case 'openFile':
        await this.openFile(msg.path, msg.line);
        return;
      case 'showDiff':
        await this.edits.openDiff(msg.toolUseId);
        return;
      case 'requestHistory':
        await this.sendHistory();
        return;
      case 'loadSession':
        await this.loadSession(msg.sessionId);
        return;
      case 'requestCompletions':
        await handleCompletions(msg.kind, msg.query, (m) => this.post(m));
        return;
      case 'removeAttachment':
        // Attachment chips are owned by the webview composer; nothing to do host-side.
        return;
      case 'pickFiles':
        await this.pickFilesFromComputer();
        return;
      case 'addContext':
        await this.addSelectionToChat();
        return;
      case 'rewind':
        await this.rewind(msg.messageId);
        return;
      case 'signIn':
        await this.signIn(msg.method);
        return;
      case 'submitAuthCode':
        await this.submitAuthCode(msg.code);
        return;
      case 'submitApiKey':
        await this.submitApiKey(msg.key);
        return;
      case 'cancelAuth':
        this.cancelAuth();
        return;
      case 'openUrl':
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case 'signOut':
        await this.signOut();
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        return;
      default:
        return;
    }
  }

  // --- session lifecycle ---------------------------------------------------

  private async ensureSession(resume?: string, initialMessages?: ChatMessage[]): Promise<AgentSession> {
    // Adopt a history session parked by `loadSession`, if any.
    const resumeId = resume ?? this.pendingResume;
    const seedMessages = initialMessages ?? this.pendingMessages;
    if (this.session && !resumeId && !seedMessages) return this.session;
    this.pendingResume = undefined;
    this.pendingMessages = undefined;

    // Tear down any existing session.
    this.session?.dispose();
    this.permissions.cancelAll('Session ended');

    const cfg = readConfig();
    const apiKey = cfg.authMethod === 'apiKey' ? await resolveApiKey(this.context) : undefined;
    const abortController = new AbortController();
    const options = buildOptions({
      config: cfg,
      authMethod: cfg.authMethod,
      apiKey,
      model: this.model,
      permissionMode: this.permissionMode,
      effort: this.effort,
      extendedThinking: this.extendedThinking,
      autoModelFallback: this.autoModelFallback,
      canUseTool: this.permissions.canUseTool,
      abortController,
      resume: resumeId,
      log: (d) => this.log.raw(d),
    });

    const session = new AgentSession({
      post: (m) => this.post(m),
      options,
      abortController,
      edits: this.edits,
      log: this.log,
      root: getWorkspaceRoot(),
      initialMessages: seedMessages,
      onSessionId: (id) => this.log.info(`Session id: ${id}`),
      onUsage: (u) => (this.usage = u),
    });
    this.session = session;
    session.start();
    return session;
  }

  newChat(): void {
    this.session?.dispose();
    this.session = undefined;
    this.pendingResume = undefined;
    this.pendingMessages = undefined;
    this.permissions.cancelAll('New chat');
    this.usage = undefined;
    void this.edits.rejectAll();
    this.sendInit();
  }

  async stop(): Promise<void> {
    await this.session?.interrupt();
  }

  // --- submitting turns ----------------------------------------------------

  async submit(text: string, attachments: Attachment[]): Promise<void> {
    // Intercept slash commands before touching auth/model so client-only
    // commands (help, config, login, …) work even when signed out.
    const trimmed = text.trim();
    let modelText = text;
    if (/^\/[a-z][\w-]*/i.test(trimmed)) {
      const result = await this.runSlashCommand(trimmed);
      if (result === 'handled') {
        // Client-side command: clear the composer's optimistic busy state.
        this.post({ type: 'status', busy: false });
        return;
      }
      if (result && typeof result === 'object') modelText = result.expandTo;
      // `null` → unknown command: fall through and send it to the model as-is.
    }

    if (!this.signedIn) {
      await this.refreshAuth();
      if (!this.signedIn) {
        this.post({ type: 'error', message: 'Not signed in. Run “Green Code: Sign In” to connect your Claude subscription or an API key.' });
        return;
      }
    }
    const promptText = await this.expandPrompt(modelText, attachments);
    const message: ChatMessage = {
      id: `u-${Date.now().toString(36)}-${userMsgSeq++}`,
      role: 'user',
      blocks: [{ type: 'text', text }],
      attachments,
      createdAt: Date.now(),
    };
    const session = await this.ensureSession();
    session.submit(message, promptText);
  }

  // --- slash commands ------------------------------------------------------

  /**
   * Execute a slash command. Returns:
   *   - `'handled'`         the command ran entirely client-side; stop here.
   *   - `{ expandTo }`      keep going through the normal submit flow, but send
   *                         `expandTo` to the model (the typed text is still what
   *                         the user sees in their bubble).
   *   - `null`             unrecognized command; treat the text as a normal prompt.
   */
  private async runSlashCommand(raw: string): Promise<'handled' | { expandTo: string } | null> {
    const [rawCmd, ...rest] = raw.split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case '/clear':
      case '/new':
        this.newChat();
        return 'handled';

      case '/help':
        this.echoCommand(raw);
        this.postSystem(this.helpText());
        return 'handled';

      case '/model':
        this.echoCommand(raw);
        if (arg) {
          const model = matchModel(arg);
          if (model) {
            await this.setModel(model);
            this.postSystem(`Model set to **${MODELS.find((m) => m.id === model)?.label ?? model}**.`);
          } else {
            this.postSystem(`Unknown model “${arg}”. Try: ${MODELS.map((m) => `\`${m.label}\``).join(', ')}.`);
          }
        } else {
          await vscode.commands.executeCommand('green-code.selectModel');
        }
        return 'handled';

      case '/permissions':
      case '/mode':
        this.echoCommand(raw);
        if (arg) {
          const mode = matchMode(arg);
          if (mode) {
            await this.setPermissionMode(mode);
            this.postSystem(`Permission mode set to **${modeLabel(mode)}**.`);
          } else {
            this.postSystem('Unknown mode. Try: `default`, `acceptEdits`, `plan`, `bypassPermissions`.');
          }
        } else {
          await vscode.commands.executeCommand('green-code.setPermissionMode');
        }
        return 'handled';

      case '/config':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:community.green-code');
        return 'handled';

      case '/cost':
        this.echoCommand(raw);
        this.postSystem(this.costText());
        return 'handled';

      case '/status':
        this.echoCommand(raw);
        this.postSystem(await this.statusText());
        return 'handled';

      case '/doctor':
        this.echoCommand(raw);
        this.postSystem(await this.doctorText());
        return 'handled';

      case '/login':
        await this.signIn();
        return 'handled';

      case '/logout':
        await this.signOut();
        return 'handled';

      case '/memory':
        await this.openMemoryFile();
        return 'handled';

      case '/mcp':
        this.echoCommand(raw);
        this.postSystem(await this.mcpStatusText());
        return 'handled';

      case '/agents':
        this.echoCommand(raw);
        this.postSystem(
          'Subagents are defined by Markdown files in `.claude/agents/` (project) or `~/.claude/agents/` (global). ' +
            'Create one there and Green Code will pick it up on the next request.',
        );
        return 'handled';

      case '/add-dir':
        this.echoCommand(raw);
        await this.addWorkingDirectory(arg);
        return 'handled';

      case '/resume':
      case '/history':
        await this.resumePicker();
        return 'handled';

      case '/bug':
        await vscode.env.openExternal(
          vscode.Uri.parse('https://github.com/community/green-code/issues/new'),
        );
        return 'handled';

      case '/release-notes':
        this.echoCommand(raw);
        this.postSystem(this.releaseNotesText());
        return 'handled';

      case '/terminal-setup':
        this.echoCommand(raw);
        this.postSystem(
          'Claude Code also runs in your terminal. Install the CLI and run `claude` in any project. ' +
            'In VS Code, keep using this panel — everything here is powered by the same engine.',
        );
        return 'handled';

      case '/vim':
        this.echoCommand(raw);
        await vscode.commands
          .executeCommand('toggleVim')
          .then(undefined, () =>
            this.postSystem('Vim mode is provided by the Vim extension. Install it, then toggle it from the status bar.'),
          );
        return 'handled';

      // Commands that produce a real model turn.
      case '/init':
        return { expandTo: this.initPrompt() };

      case '/review':
        return { expandTo: this.reviewPrompt(arg) };

      case '/compact':
        return {
          expandTo:
            'Compact our conversation so far: produce a concise summary capturing the key context, decisions, ' +
            'files touched, and next steps, so we can continue with less context.' +
            (arg ? ` Focus on: ${arg}.` : ''),
        };

      default:
        return null;
    }
  }

  /** Post a user-role echo of the raw command so it appears in the transcript. */
  private echoCommand(raw: string): void {
    this.post({
      type: 'appendMessage',
      message: {
        id: `u-${Date.now().toString(36)}-${userMsgSeq++}`,
        role: 'user',
        blocks: [{ type: 'text', text: raw }],
        createdAt: Date.now(),
      },
    });
  }

  /** Post a system-role message (markdown) into the transcript. */
  private postSystem(markdown: string): void {
    this.post({
      type: 'appendMessage',
      message: {
        id: `sys-${Date.now().toString(36)}-${userMsgSeq++}`,
        role: 'system',
        blocks: [{ type: 'text', text: markdown }],
        createdAt: Date.now(),
      },
    });
  }

  private helpText(): string {
    const lines = SLASH_COMMANDS.map(
      (c) => `- \`${c.name}${c.argHint ? ` ${c.argHint}` : ''}\` — ${c.description}`,
    );
    return (
      '### Green Code commands\n\n' +
      lines.join('\n') +
      '\n\nType `@` to attach files, `/` to run a command. Press **Shift+Enter** for a newline.'
    );
  }

  private costText(): string {
    const u = this.usage;
    if (!u) return 'No usage recorded yet this session.';
    const total = u.inputTokens + u.outputTokens;
    const parts = [
      `- **Total tokens:** ${total.toLocaleString()} (in ${u.inputTokens.toLocaleString()} / out ${u.outputTokens.toLocaleString()})`,
    ];
    if (u.cacheReadTokens) parts.push(`- **Cache reads:** ${u.cacheReadTokens.toLocaleString()}`);
    if (typeof u.costUsd === 'number') parts.push(`- **Cost:** $${u.costUsd.toFixed(4)}`);
    if (u.contextTokens && u.contextWindow) {
      const pct = Math.round((u.contextTokens / u.contextWindow) * 100);
      parts.push(`- **Context:** ${u.contextTokens.toLocaleString()} / ${u.contextWindow.toLocaleString()} (${pct}%)`);
    }
    return '### Session usage\n\n' + parts.join('\n');
  }

  private async statusText(): Promise<string> {
    const account =
      this.auth.method === 'apiKey'
        ? this.auth.signedIn
          ? 'API key (Console billing)'
          : 'API key — not set'
        : this.auth.signedIn
          ? `Subscription — ${this.auth.email ?? 'signed in'}${this.auth.plan ? ` (${this.auth.plan})` : ''}`
          : 'Subscription — signed out';
    const root = getWorkspaceRoot();
    return (
      '### Status\n\n' +
      `- **Account:** ${account}\n` +
      `- **Model:** ${MODELS.find((m) => m.id === this.model)?.label ?? this.model}\n` +
      `- **Permission mode:** ${modeLabel(this.permissionMode)}\n` +
      `- **Workspace:** ${root ? `\`${root}\`` : '_none_'}`
    );
  }

  private async doctorText(): Promise<string> {
    const bin = resolveClaudeBinary();
    const cfg = readConfig();
    const checks = [
      `- **Claude runtime:** ${bin ? `found (\`${bin}\`)` : '❌ not found'}`,
      `- **Auth method:** ${cfg.authMethod}`,
      `- **Signed in:** ${this.signedIn ? 'yes' : 'no'}`,
      `- **Workspace:** ${getWorkspaceRoot() ? 'ok' : 'no folder open'}`,
      `- **Settings sources:** ${cfg.loadProjectSettings ? 'user, project, local' : 'none (isolated)'}`,
    ];
    return '### Doctor\n\n' + checks.join('\n');
  }

  /** Live MCP server status, queried from the running agent. */
  private async mcpStatusText(): Promise<string> {
    if (!readConfig().loadProjectSettings) {
      return (
        '### MCP servers\n\nMCP is disabled: `green-code.loadProjectSettings` is off, so no ' +
        'settings sources are loaded. Turn it on to use MCP servers from your user or project configuration.'
      );
    }

    const servers = await this.session?.mcpServerStatus();
    if (!servers) {
      return (
        '### MCP servers\n\nNo agent is running yet — MCP servers connect when the session starts. ' +
        'Send a message first, then run `/mcp` again.'
      );
    }
    if (servers.length === 0) {
      return (
        '### MCP servers\n\nNone configured. Add servers to the workspace `.mcp.json`, ' +
        'or globally via `claude mcp add`.'
      );
    }

    const icon: Record<string, string> = {
      connected: '✔',
      failed: '✖',
      'needs-auth': '🔑',
      pending: '⏸',
      disabled: '⊘',
    };
    const lines = servers.map((s) => {
      const tools = s.serverInfo?.name ? ` — \`${s.serverInfo.name}\`` : '';
      return `- ${icon[s.status] ?? '•'} **${s.name}** — ${s.status}${tools}`;
    });

    const notes: string[] = [];
    const failed = servers.filter((s) => s.status === 'failed');
    const needsAuth = servers.filter((s) => s.status === 'needs-auth');
    if (failed.length) notes.push(`${failed.length} server(s) failed to start — check their command and arguments.`);
    if (needsAuth.length) notes.push(`${needsAuth.length} server(s) need authentication — run \`claude mcp\` to sign in.`);

    return '### MCP servers\n\n' + lines.join('\n') + (notes.length ? '\n\n' + notes.map((n) => `> ${n}`).join('\n>\n') : '');
  }

  private releaseNotesText(): string {
    return (
      '### Green Code\n\n' +
      'A community VS Code extension built on the Claude Agent SDK. ' +
      'See the repository CHANGELOG for the full history of changes.'
    );
  }

  private initPrompt(): string {
    return (
      'Please analyze this codebase and create a CLAUDE.md file containing: ' +
      'an overview of what the project does, the key build/test/lint commands, ' +
      'the high-level architecture and important files, and any conventions a ' +
      'contributor should follow. Write it to CLAUDE.md at the project root.'
    );
  }

  private reviewPrompt(arg: string): string {
    if (arg) {
      return `Please review ${/^\d+$/.test(arg) ? `pull request #${arg}` : arg} and give concrete, actionable feedback on correctness, design, and potential bugs.`;
    }
    return 'Please review the current uncommitted changes (git diff) and give concrete, actionable feedback on correctness, design, and potential bugs.';
  }

  private async addWorkingDirectory(arg: string): Promise<void> {
    if (!arg) {
      this.postSystem('Usage: `/add-dir <path>` — provide a directory to grant the agent access to.');
      return;
    }
    const cfg = vscode.workspace.getConfiguration('green-code');
    const dirs = cfg.get<string[]>('additionalDirectories', []);
    if (dirs.includes(arg)) {
      this.postSystem(`\`${arg}\` is already in the allowed directories.`);
      return;
    }
    await cfg.update('additionalDirectories', [...dirs, arg], vscode.ConfigurationTarget.Global);
    this.postSystem(`Added \`${arg}\` to allowed directories. It takes effect on the next chat.`);
  }

  private async openMemoryFile(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) {
      this.postSystem('Open a folder first to edit its CLAUDE.md memory file.');
      return;
    }
    const uri = vscode.Uri.joinPath(vscode.Uri.file(root), 'CLAUDE.md');
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      const template = new TextEncoder().encode('# CLAUDE.md\n\nProject guidance for Claude Code.\n');
      await vscode.workspace.fs.writeFile(uri, template);
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  }

  private async resumePicker(): Promise<void> {
    const entries = await listHistory(this.log);
    if (!entries.length) {
      this.postSystem('No previous conversations found.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      entries.map((e) => ({
        label: e.title || 'Untitled conversation',
        description: `${e.messageCount} messages · ${new Date(e.updatedAt).toLocaleString()}`,
        sessionId: e.sessionId,
      })),
      { title: 'Resume a conversation', placeHolder: 'Select a conversation to resume' },
    );
    if (pick) await this.loadSession(pick.sessionId);
  }

  /** Expand attachments into the prompt text sent to the model. */
  private async expandPrompt(text: string, attachments: Attachment[]): Promise<string> {
    const parts: string[] = [];
    for (const att of attachments) {
      const block = await this.attachmentToBlock(att);
      if (block) parts.push(block);
    }
    parts.push(text);
    return parts.join('\n\n');
  }

  private async attachmentToBlock(att: Attachment): Promise<string | undefined> {
    if (att.kind === 'image') return undefined; // images are handled via SDK content, not text
    if (!att.path) return undefined;
    const root = getWorkspaceRoot();
    // Uploaded-from-computer files carry an absolute path (possibly outside the
    // workspace); project attachments carry a workspace-relative one.
    const uri =
      root && !path.isAbsolute(att.path)
        ? vscode.Uri.file(vscode.Uri.joinPath(vscode.Uri.file(root), att.path).fsPath)
        : vscode.Uri.file(att.path);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      let content = Buffer.from(bytes).toString('utf8');
      if (att.kind === 'selection' && att.range) {
        const lines = content.split('\n');
        content = lines.slice(att.range.startLine - 1, att.range.endLine).join('\n');
        return `\`\`\`${att.path} (lines ${att.range.startLine}-${att.range.endLine})\n${content}\n\`\`\``;
      }
      return `\`\`\`${att.path}\n${content}\n\`\`\``;
    } catch {
      return `[Attached ${att.label} — could not read file contents]`;
    }
  }

  // --- settings ------------------------------------------------------------

  /** Broadcast the current model / mode / reasoning settings to the webview. */
  private postSettings(): void {
    this.post({
      type: 'settings',
      model: this.model,
      permissionMode: this.permissionMode,
      effort: this.effort,
      extendedThinking: this.extendedThinking,
      autoModelFallback: this.autoModelFallback,
    });
  }

  async setModel(model: ModelId): Promise<void> {
    this.model = model;
    await vscode.workspace.getConfiguration('green-code').update('model', model, vscode.ConfigurationTarget.Global);
    await this.session?.setModel(model);
    this.postSettings();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    this.permissions.setMode(mode);
    await vscode.workspace
      .getConfiguration('green-code')
      .update('permissionMode', mode, vscode.ConfigurationTarget.Global);
    await this.session?.setPermissionMode(mode);
    this.postSettings();
  }

  /**
   * Reasoning effort. The SDK has no runtime setter (only `setModel` /
   * `setPermissionMode` / `setMaxThinkingTokens`), so this persists the choice
   * and it takes effect on the next chat / turn that starts a fresh `query()`.
   */
  async setEffort(effort: EffortLevel): Promise<void> {
    this.effort = effort;
    await vscode.workspace.getConfiguration('green-code').update('effort', effort, vscode.ConfigurationTarget.Global);
    this.postSettings();
  }

  /** Toggle extended thinking — applied live to the running session. */
  async setThinking(enabled: boolean): Promise<void> {
    this.extendedThinking = enabled;
    await vscode.workspace
      .getConfiguration('green-code')
      .update('extendedThinking', enabled, vscode.ConfigurationTarget.Global);
    await this.session?.setThinking(enabled);
    this.postSettings();
  }

  /** Toggle the fallback model ("switch models when a message is flagged"). */
  async setModelFallback(enabled: boolean): Promise<void> {
    this.autoModelFallback = enabled;
    await vscode.workspace
      .getConfiguration('green-code')
      .update('autoModelFallback', enabled, vscode.ConfigurationTarget.Global);
    this.postSettings();
  }

  getModel(): ModelId {
    return this.model;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  // --- edits ---------------------------------------------------------------

  private async decideEdit(toolUseId: string, accept: boolean): Promise<void> {
    if (accept) this.edits.accept(toolUseId);
    else await this.edits.reject(toolUseId);
  }

  acceptEdit(toolUseId: string): void {
    this.edits.accept(toolUseId);
  }

  async rejectEdit(toolUseId: string): Promise<void> {
    await this.edits.reject(toolUseId);
  }

  acceptAllEdits(): void {
    this.edits.acceptAll();
  }

  async rejectAllEdits(): Promise<void> {
    await this.edits.rejectAll();
  }

  private async openFile(relOrAbsPath: string, line?: number): Promise<void> {
    const root = getWorkspaceRoot();
    const uri =
      root && !path.isAbsolute(relOrAbsPath)
        ? vscode.Uri.joinPath(vscode.Uri.file(root), relOrAbsPath)
        : vscode.Uri.file(relOrAbsPath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      if (line !== undefined) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch (err) {
      this.log.warn('openFile failed', err);
    }
  }

  // --- editor context commands --------------------------------------------

  async addSelectionToChat(): Promise<void> {
    await this.reveal();
    const built = this.editorTracker.selectionAttachment();
    if (built) {
      this.post({ type: 'addAttachment', attachment: built.attachment });
    } else {
      // No selection — fall back to pinning the active file.
      this.post({ type: 'editorContext', context: this.editorTracker.current() });
      this.post({ type: 'focusInput' });
    }
  }

  /**
   * `+` → "Upload from computer": open a native file picker and pin the chosen
   * file(s) as *external* attachments (rendered above the input). Images are
   * carried as data URIs; other files are pinned by absolute path and their
   * contents are inlined into the prompt on submit.
   */
  private async pickFilesFromComputer(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      title: 'Attach files from your computer',
    });
    if (!picks?.length) return;
    await this.reveal();
    for (const uri of picks) {
      const label = uri.path.split('/').pop() || uri.fsPath;
      const ext = label.split('.').pop()?.toLowerCase() ?? '';
      const attachment: Attachment = IMAGE_EXTS.has(ext)
        ? { kind: 'image', label, external: true, dataUri: await this.readAsDataUri(uri, ext) }
        : { kind: 'file', label, external: true, path: uri.fsPath };
      this.post({ type: 'addAttachment', attachment });
    }
  }

  private async readAsDataUri(uri: vscode.Uri, ext: string): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
      return `data:image/${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    } catch (err) {
      this.log.warn('readAsDataUri failed', err);
      return undefined;
    }
  }

  async addFileToChat(uri: vscode.Uri): Promise<void> {
    await this.reveal();
    const built = await this.editorTracker.fileAttachment(uri);
    if (built) this.post({ type: 'addAttachment', attachment: built.attachment });
    else this.post({ type: 'focusInput' });
  }

  focusInput(): void {
    this.post({ type: 'focusInput' });
  }

  async explainSelection(): Promise<void> {
    const built = this.editorTracker.selectionAttachment();
    if (!built) return;
    await this.reveal();
    await this.submit('Explain this code.', [built.attachment]);
  }

  async fixSelection(): Promise<void> {
    const built = this.editorTracker.selectionAttachment();
    if (!built) return;
    await this.reveal();
    await this.submit('Find and fix any problems in this code.', [built.attachment]);
  }

  // --- history -------------------------------------------------------------

  async sendHistory(): Promise<void> {
    const entries = await listHistory(this.log);
    this.post({ type: 'history', entries });
  }

  async loadSession(sessionId: string): Promise<void> {
    try {
      const messages = await loadSessionMessages(sessionId, getWorkspaceRoot(), this.log);
      // Viewing history must not spawn an agent process. Tear down any live
      // session and park the transcript + resume id; `ensureSession` adopts
      // them when the user sends the next turn, resuming the conversation.
      this.session?.dispose();
      this.session = undefined;
      this.permissions.cancelAll('Switched session');
      this.usage = undefined;
      this.pendingResume = sessionId;
      this.pendingMessages = messages;
      this.sendInit();
    } catch (err) {
      this.log.error('loadSession failed', err);
      this.post({ type: 'error', message: `Failed to load session: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async rewind(messageId: string): Promise<void> {
    // The SDK has no first-class checkpoint-rewind for an active streaming
    // session, so we approximate by trimming the local transcript to the
    // checkpoint and re-initializing the view. Underlying model history is
    // unchanged. (See report: needs a protocol/SDK checkpoint hook.)
    const session = this.session;
    if (!session) return;
    const idx = session.messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      session.messages.splice(idx + 1);
      this.sendInit();
    }
  }

  // --- auth ----------------------------------------------------------------

  /** Re-evaluate auth for the configured method and broadcast the result. */
  async refreshAuth(): Promise<void> {
    const method = readConfig().authMethod;
    let auth: AuthInfo = { signedIn: false, method };

    if (method === 'apiKey') {
      const key = await resolveApiKey(this.context);
      auth = { signedIn: !!key, method: 'apiKey' };
    } else {
      const bin = resolveClaudeBinary();
      if (bin) {
        const status = await getAuthStatus(bin);
        auth = {
          signedIn: status.loggedIn,
          method: 'subscription',
          email: status.email,
          plan: status.subscriptionType,
        };
      }
    }

    this.auth = auth;
    this.signedIn = auth.signedIn;
    this.post({ type: 'authState', signedIn: this.signedIn, auth });
  }

  /** Drive the in-panel sign-in flow. `method` picks the path directly. */
  async signIn(method?: AuthMethod): Promise<void> {
    if (!method) {
      if (this.signedIn) {
        this.postSystem(
          `You're already signed in${this.auth.email ? ` as **${this.auth.email}**` : ''}. Run \`/logout\` first to switch accounts.`,
        );
        return;
      }
      this.postAuthPrompt('choose');
      return;
    }
    if (method === 'apiKey') {
      this.postAuthPrompt('awaitingKey', { method });
      return;
    }
    await this.beginSubscriptionLogin();
  }

  private postAuthPrompt(stage: AuthStage, extra?: { method?: AuthMethod; url?: string; message?: string }): void {
    this.post({ type: 'authPrompt', stage, ...extra });
  }

  /** Spawn the headless OAuth login, open the browser, await the pasted code. */
  private async beginSubscriptionLogin(): Promise<void> {
    const bin = resolveClaudeBinary();
    if (!bin) {
      this.postAuthPrompt('error', { method: 'subscription', message: installHint() });
      return;
    }
    await this.setAuthMethod('subscription');

    // Already logged in? Skip the browser flow entirely.
    const existing = await getAuthStatus(bin);
    if (existing.loggedIn) {
      await this.refreshAuth();
      return;
    }

    this.cancelAuth(); // tear down any prior attempt
    this.postAuthPrompt('working', { method: 'subscription', message: 'Opening your browser…' });

    const session = startLogin(bin, 'subscription');
    this.loginSession = session;

    const url = await session.url;
    if (!url) {
      this.postAuthPrompt('error', { method: 'subscription', message: 'Sign-in could not be started. Please try again.' });
      this.loginSession = undefined;
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
    this.postAuthPrompt('awaitingCode', { method: 'subscription', url });
  }

  /** Receive the OAuth code pasted from the browser and finish the login. */
  private async submitAuthCode(code: string): Promise<void> {
    const session = this.loginSession;
    if (!session || !code.trim()) return;
    this.postAuthPrompt('working', { method: 'subscription', message: 'Signing in…' });

    const result = await session.submitCode(code);
    this.loginSession = undefined;

    if (result === 'invalid') {
      this.postAuthPrompt('error', {
        method: 'subscription',
        message: 'That code was not accepted. Please try again and paste the full code from the browser.',
      });
      return;
    }

    await this.refreshAuth();
    if (this.signedIn) {
      vscode.window.showInformationMessage(
        `Green Code: signed in${this.auth.email ? ` as ${this.auth.email}` : ''}${this.auth.plan ? ` (${this.auth.plan})` : ''}.`,
      );
    } else {
      this.postAuthPrompt('error', {
        method: 'subscription',
        message: 'Sign-in did not complete. Please start over and paste the code from the browser.',
      });
    }
  }

  private async submitApiKey(key: string): Promise<void> {
    if (!key.trim()) return;
    this.postAuthPrompt('working', { method: 'apiKey', message: 'Saving key…' });
    await storeApiKey(this.context, key.trim());
    await this.setAuthMethod('apiKey');
    await this.refreshAuth();
    if (this.signedIn) {
      vscode.window.showInformationMessage('Green Code: API key saved.');
    } else {
      this.postAuthPrompt('error', { method: 'apiKey', message: 'Could not validate the API key. Please try again.' });
    }
  }

  private cancelAuth(): void {
    this.loginSession?.cancel();
    this.loginSession = undefined;
  }

  private async setAuthMethod(method: AuthMethod): Promise<void> {
    await vscode.workspace
      .getConfiguration('green-code')
      .update('authMethod', method, vscode.ConfigurationTarget.Global);
  }

  async signOut(): Promise<void> {
    const method = readConfig().authMethod;
    if (method === 'subscription') {
      const bin = resolveClaudeBinary();
      if (bin) await cliLogout(bin);
    } else {
      await clearApiKey(this.context);
    }
    await this.refreshAuth();
    vscode.window.showInformationMessage('Green Code: signed out.');
  }

  dispose(): void {
    this.session?.dispose();
    this.editorTracker.dispose();
    this.edits.dispose();
  }
}

/** Resolve a `/model` argument (id or fuzzy label) to a known ModelId. */
function matchModel(arg: string): ModelId | undefined {
  const q = arg.trim().toLowerCase();
  const exact = MODELS.find((m) => m.id.toLowerCase() === q);
  if (exact) return exact.id;
  const byLabel = MODELS.find(
    (m) => m.label.toLowerCase() === q || m.label.toLowerCase().replace(/\s+/g, '') === q.replace(/\s+/g, ''),
  );
  if (byLabel) return byLabel.id;
  // Keyword: "opus", "sonnet", "haiku", "default".
  const byKeyword = MODELS.find((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
  return byKeyword?.id;
}

/** Resolve a `/permissions` argument to a known PermissionMode. */
function matchMode(arg: string): PermissionMode | undefined {
  const q = arg.trim().toLowerCase().replace(/[\s_-]/g, '');
  const map: Record<string, PermissionMode> = {
    default: 'default',
    normal: 'default',
    ask: 'default',
    acceptedits: 'acceptEdits',
    accept: 'acceptEdits',
    autoaccept: 'acceptEdits',
    plan: 'plan',
    readonly: 'plan',
    bypass: 'bypassPermissions',
    bypasspermissions: 'bypassPermissions',
    yolo: 'bypassPermissions',
  };
  return map[q];
}

function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
      return 'Accept edits';
    case 'plan':
      return 'Plan';
    case 'bypassPermissions':
      return 'Bypass permissions';
    default:
      return 'Default';
  }
}
