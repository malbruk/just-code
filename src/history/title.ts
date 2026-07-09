import { loadSdk } from '../agent/sdk';
import type { Logger } from '../util/logger';

const POLL_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 400;

/**
 * Read the stored title of an existing session.
 *
 * Two kinds of title end up in a transcript: the one this extension writes with
 * {@link persistSessionTitle}, and the `{"type":"ai-title"}` record the native
 * binary appends on its own. The SDK's extractor folds both into `customTitle`,
 * newest wins.
 *
 * `getSessionInfo().summary` is *not* the right field: it falls back to the
 * first prompt when no title exists, so it can never tell "titled" from
 * "untitled". A defined `customTitle` is the precise signal.
 *
 * The record lands asynchronously with respect to a turn's `result` message,
 * so poll briefly rather than reading once. Resolves `undefined` when the
 * session has no title — callers keep their own fallback.
 */
export async function fetchSessionTitle(
  sessionId: string,
  dir: string | undefined,
  log: Logger,
): Promise<string | undefined> {
  try {
    const { getSessionInfo } = await loadSdk();
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      const info = await getSessionInfo(sessionId, { dir });
      const title = info?.customTitle?.trim();
      if (title) return title;
      await delay(POLL_INTERVAL_MS);
    }
    log.info(`No generated title for session ${sessionId} yet`);
  } catch (err) {
    log.warn('fetchSessionTitle failed', err);
  }
  return undefined;
}

/**
 * Store a title on the session transcript, so the history list and a later
 * resume both show it. Written as a custom title, which outranks the binary's
 * own `ai-title` record everywhere the SDK reads titles.
 */
export async function persistSessionTitle(
  sessionId: string,
  title: string,
  dir: string | undefined,
  log: Logger,
): Promise<void> {
  try {
    const { renameSession } = await loadSdk();
    await renameSession(sessionId, title, { dir });
  } catch (err) {
    log.warn('persistSessionTitle failed', err);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
