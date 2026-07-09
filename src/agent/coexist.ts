import * as vscode from 'vscode';

/**
 * Coexistence with Anthropic's official Claude Code extension.
 *
 * Both extensions drive the *same* local `claude` runtime, which keeps its
 * credentials (`~/.claude/.credentials.json`) and its config (`~/.claude.json`)
 * in single files with no cross-process locking, and bills both against the same
 * plan. Running the two side by side works — two concurrent runtimes were
 * verified to complete independently — but three things are genuinely shared:
 *
 *   1. the rotating OAuth refresh token (refreshed roughly every 6 hours),
 *   2. `~/.claude.json`, rewritten in full on every run,
 *   3. the account's usage limits.
 *
 * So a simultaneous prompt in both panels can occasionally kill one session.
 * We cannot lock files we do not own; what we can do is tell the user why.
 */

export const OFFICIAL_EXTENSION_ID = 'anthropic.claude-code';

const TIP_KEY = 'yes-code.coexistenceTipShown';

/** True when Anthropic's Claude Code extension is installed and enabled. */
export function officialExtensionInstalled(): boolean {
  return vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID) !== undefined;
}

/**
 * Show a one-time, non-blocking note that the two extensions share state.
 * No-op when the official extension is absent or the tip was already shown.
 */
export async function showCoexistenceTipOnce(context: vscode.ExtensionContext): Promise<void> {
  if (!officialExtensionInstalled()) return;
  if (context.globalState.get<boolean>(TIP_KEY)) return;
  await context.globalState.update(TIP_KEY, true);

  const choice = await vscode.window.showInformationMessage(
    'Yes Code and Anthropic’s Claude Code extension are both installed. They share the same sign-in, configuration file, ' +
      'and plan usage — running a prompt in both at once usually works, but can occasionally make one session fail.',
    'Got it',
  );
  void choice;
}
