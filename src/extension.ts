import * as vscode from 'vscode';
import { Logger } from './util/logger';
import { clearBinaryCache } from './agent/cli';
import { showCoexistenceTipOnce } from './agent/coexist';
import { SessionManager } from './agent/sessionManager';
import { ChatViewProvider } from './panel/chatViewProvider';
import { registerToolOutputDocuments } from './tools/toolOutput';
import { MODELS } from '@just-code/core';
import type { ModelId, PermissionMode } from '@just-code/core';

let logger: Logger | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger();
  logger = log;
  log.info('Just Code activating');

  const manager = new SessionManager(context, log);
  const provider = new ChatViewProvider(context, manager, log);

  context.subscriptions.push(
    log,
    manager,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    registerToolOutputDocuments(),
  );

  const cmd = (id: string, fn: (...args: any[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        log.error(`Command ${id} failed`, err);
        vscode.window.showErrorMessage(`Just Code: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  context.subscriptions.push(
    cmd('just-code.openChat', () => provider.reveal()),
    cmd('just-code.newChat', () => manager.newChat()),
    cmd('just-code.newChatInEditor', () => provider.openInEditor()),
    cmd('just-code.stop', () => manager.stop()),
    cmd('just-code.history', async () => {
      await provider.reveal();
      await manager.sendHistory();
    }),
    cmd('just-code.addSelectionToChat', () => manager.addSelectionToChat()),
    cmd('just-code.addFileToChat', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) return manager.addFileToChat(target);
      return undefined;
    }),
    cmd('just-code.explainSelection', () => manager.explainSelection()),
    cmd('just-code.fixSelection', () => manager.fixSelection()),
    cmd('just-code.acceptAllEdits', () => manager.acceptAllEdits()),
    cmd('just-code.rejectAllEdits', () => manager.rejectAllEdits()),
    cmd('just-code.acceptEdit', (toolUseId?: string) => {
      if (toolUseId) manager.acceptEdit(toolUseId);
    }),
    cmd('just-code.rejectEdit', (toolUseId?: string) => {
      if (toolUseId) return manager.rejectEdit(toolUseId);
      return undefined;
    }),
    cmd('just-code.selectModel', () => selectModel(manager)),
    cmd('just-code.setPermissionMode', () => selectPermissionMode(manager)),
    cmd('just-code.signIn', () => manager.signIn()),
    cmd('just-code.signOut', () => manager.signOut()),
    cmd('just-code.rewind', () => undefined),
    cmd('just-code.focusInput', async () => {
      await provider.reveal();
      manager.focusInput();
    }),
    cmd('just-code.moveView', () => moveChatToDrawer()),
  );

  // Re-evaluate auth if the stored secret changes elsewhere.
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === 'just-code.apiKey') void manager.refreshAuth();
    }),
  );

  // The resolved `claude` path is cached. Re-discover when the user points us at
  // a different executable — otherwise the stale path survives until reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('just-code.claudeExecutablePath')) {
        clearBinaryCache();
        void manager.refreshAuth();
      }
    }),
  );

  void vscode.commands.executeCommand('setContext', 'just-code.hasPendingEdits', false);

  // One-time tip: how to keep files + chat visible side by side.
  const TIP_KEY = 'just-code.placementTipShown';
  if (!context.globalState.get<boolean>(TIP_KEY)) {
    void context.globalState.update(TIP_KEY, true);
    void vscode.window
      .showInformationMessage(
        'Just Code opens in the side bar. Move it to a side drawer to chat while your files and Explorer stay visible.',
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
    await vscode.commands.executeCommand('just-code.chat.focus');
    await vscode.commands.executeCommand('workbench.action.moveFocusedView');
  } catch {
    await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
    void vscode.window.showInformationMessage(
      'Drag the Just Code view into the Secondary Side Bar to dock it as a right-hand drawer.',
    );
  }
}

export function deactivate(): void {
  logger?.info('Just Code deactivating');
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
