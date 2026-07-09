import * as vscode from 'vscode';
import { Logger } from './util/logger';
import { clearBinaryCache } from './agent/cli';
import { showCoexistenceTipOnce } from './agent/coexist';
import { SessionManager } from './agent/sessionManager';
import { ChatViewProvider } from './panel/chatViewProvider';
import { MODELS } from './shared/protocol';
import type { ModelId, PermissionMode } from './shared/protocol';

let logger: Logger | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger();
  logger = log;
  log.info('Yes Code activating');

  const manager = new SessionManager(context, log);
  const provider = new ChatViewProvider(context, manager, log);

  context.subscriptions.push(
    log,
    manager,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const cmd = (id: string, fn: (...args: any[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        log.error(`Command ${id} failed`, err);
        vscode.window.showErrorMessage(`Yes Code: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  context.subscriptions.push(
    cmd('yes-code.openChat', () => provider.reveal()),
    cmd('yes-code.newChat', () => manager.newChat()),
    cmd('yes-code.newChatInEditor', () => provider.openInEditor()),
    cmd('yes-code.stop', () => manager.stop()),
    cmd('yes-code.history', async () => {
      await provider.reveal();
      await manager.sendHistory();
    }),
    cmd('yes-code.addSelectionToChat', () => manager.addSelectionToChat()),
    cmd('yes-code.addFileToChat', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) return manager.addFileToChat(target);
      return undefined;
    }),
    cmd('yes-code.explainSelection', () => manager.explainSelection()),
    cmd('yes-code.fixSelection', () => manager.fixSelection()),
    cmd('yes-code.acceptAllEdits', () => manager.acceptAllEdits()),
    cmd('yes-code.rejectAllEdits', () => manager.rejectAllEdits()),
    cmd('yes-code.acceptEdit', (toolUseId?: string) => {
      if (toolUseId) manager.acceptEdit(toolUseId);
    }),
    cmd('yes-code.rejectEdit', (toolUseId?: string) => {
      if (toolUseId) return manager.rejectEdit(toolUseId);
      return undefined;
    }),
    cmd('yes-code.selectModel', () => selectModel(manager)),
    cmd('yes-code.setPermissionMode', () => selectPermissionMode(manager)),
    cmd('yes-code.signIn', () => manager.signIn()),
    cmd('yes-code.signOut', () => manager.signOut()),
    cmd('yes-code.rewind', () => undefined),
    cmd('yes-code.focusInput', async () => {
      await provider.reveal();
      manager.focusInput();
    }),
    cmd('yes-code.moveView', () => moveChatToDrawer()),
  );

  // Re-evaluate auth if the stored secret changes elsewhere.
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === 'yes-code.apiKey') void manager.refreshAuth();
    }),
  );

  // The resolved `claude` path is cached. Re-discover when the user points us at
  // a different executable — otherwise the stale path survives until reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('yes-code.claudeExecutablePath')) {
        clearBinaryCache();
        void manager.refreshAuth();
      }
    }),
  );

  void vscode.commands.executeCommand('setContext', 'yes-code.hasPendingEdits', false);

  // One-time tip: how to keep files + chat visible side by side.
  const TIP_KEY = 'yes-code.placementTipShown';
  if (!context.globalState.get<boolean>(TIP_KEY)) {
    void context.globalState.update(TIP_KEY, true);
    void vscode.window
      .showInformationMessage(
        'Yes Code opens in the side bar. Move it to a side drawer to chat while your files and Explorer stay visible.',
        'Move to Side Drawer',
        'Not now',
      )
      .then((choice) => {
        if (choice === 'Move to Side Drawer') void moveChatToDrawer();
      });
  } else {
    // One-time note that Anthropic's extension shares our sign-in, config and
    // usage. Deferred past the very first activation so it never stacks on top
    // of the placement tip.
    void showCoexistenceTipOnce(context);
  }
}

/**
 * Focus the chat view, then open VS Code's native "Move View" picker so the
 * user can send it to the Secondary Side Bar (right drawer), the primary side
 * bar (left), or the bottom panel — coexisting with the editor and Explorer.
 */
async function moveChatToDrawer(): Promise<void> {
  try {
    await vscode.commands.executeCommand('yes-code.chat.focus');
    await vscode.commands.executeCommand('workbench.action.moveFocusedView');
  } catch {
    await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
    void vscode.window.showInformationMessage(
      'Drag the Yes Code view into the Secondary Side Bar to dock it as a right-hand drawer.',
    );
  }
}

export function deactivate(): void {
  logger?.info('Yes Code deactivating');
}

async function selectModel(manager: SessionManager): Promise<void> {
  const current = manager.getModel();
  const pick = await vscode.window.showQuickPick(
    MODELS.map((m) => ({
      label: m.label,
      description: m.id === current ? `${m.description} (current)` : m.description,
      id: m.id as ModelId,
    })),
    { title: 'Select Claude model' },
  );
  if (pick) await manager.setModel(pick.id);
}

async function selectPermissionMode(manager: SessionManager): Promise<void> {
  const modes: { label: string; description: string; id: PermissionMode }[] = [
    { label: 'Default', description: 'Ask before each tool use', id: 'default' },
    { label: 'Accept Edits', description: 'Auto-accept file edits', id: 'acceptEdits' },
    { label: 'Plan', description: 'Read-only, propose a plan first', id: 'plan' },
    { label: 'Bypass Permissions', description: 'Never prompt (use with caution)', id: 'bypassPermissions' },
  ];
  const current = manager.getPermissionMode();
  const pick = await vscode.window.showQuickPick(
    modes.map((m) => ({ ...m, description: m.id === current ? `${m.description} (current)` : m.description })),
    { title: 'Select permission mode' },
  );
  if (pick) await manager.setPermissionMode(pick.id);
}
