/**
 * Central access point for the ESM-only `@anthropic-ai/claude-agent-sdk`.
 *
 * The extension host compiles to CommonJS (Node16 module resolution), so the
 * package's runtime values must be reached via a dynamic `import()`, and its
 * types must be imported with an explicit `resolution-mode`. Every other host
 * module imports SDK types from *this* file to avoid repeating that ceremony.
 */

export type {
  Query,
  SDKMessage,
  SDKUserMessage,
  Options,
  ThinkingConfig,
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  SDKSessionInfo,
  SessionMessage,
  RewindFilesResult,
  McpServerStatus,
  McpSdkServerConfigWithInstance,
  SDKControlGetUsageResponse,
  SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };

import type * as SDK from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };

let cached: Promise<typeof SDK> | undefined;

/** Lazily import (once) and cache the SDK module namespace. */
export function loadSdk(): Promise<typeof SDK> {
  return (cached ??= import('@anthropic-ai/claude-agent-sdk'));
}
