import * as crypto from 'node:crypto';

/** Generate a cryptographically-unguessable nonce for CSP script tags. */
export function getNonce(): string {
  return crypto.randomBytes(24).toString('base64');
}
