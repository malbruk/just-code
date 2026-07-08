import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import type { SessionManager } from '../agent/sessionManager';
import { getNonce } from '../util/nonce';
import type { Logger } from '../util/logger';

/**
 * Hosts the chat webview both as a sidebar view (`yes-code.chat`) and, on
 * demand, as an editor-tab panel. All live webviews share the same
 * {@link SessionManager}; host messages are broadcast to every one of them.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'yes-code.chat';

  private readonly webviews = new Set<vscode.Webview>();
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: SessionManager,
    private readonly log: Logger,
  ) {
    manager.connect(
      (msg) => this.broadcast(msg),
      () => this.reveal(),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = this.webviewOptions();
    view.webview.html = this.getHtml(view.webview);
    this.register(view.webview);
    view.onDidDispose(() => {
      this.webviews.delete(view.webview);
      if (this.view === view) this.view = undefined;
    });
  }

  /** Open the chat in an editor tab, reusing the same HTML/bridge. */
  openInEditor(): void {
    const panel = vscode.window.createWebviewPanel(
      'yes-code.chatEditor',
      'Yes Code',
      vscode.ViewColumn.Active,
      this.webviewOptions(),
    );
    panel.webview.html = this.getHtml(panel.webview);
    this.register(panel.webview);
    panel.onDidDispose(() => this.webviews.delete(panel.webview));
  }

  /** Reveal/focus the sidebar chat view. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
    } else {
      await vscode.commands.executeCommand('yes-code.chat.focus');
    }
  }

  private register(webview: vscode.Webview): void {
    this.webviews.add(webview);
    webview.onDidReceiveMessage((raw: WebviewToHost) => {
      void this.manager.handleMessage(raw).catch((err) => {
        this.log.error('handleMessage failed', err);
        // Surface it. Swallowing this to the output channel leaves the user
        // staring at a chat that silently does nothing — the composer never
        // even leaves the busy state.
        this.broadcast({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        this.broadcast({ type: 'status', busy: false });
      });
    });
  }

  private broadcast(msg: HostToWebview): void {
    for (const webview of this.webviews) {
      void webview.postMessage(msg);
    }
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'webview.css'));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Yes Code</title>
</head>
<body>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
