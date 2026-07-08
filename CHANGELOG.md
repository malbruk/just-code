# Changelog

## 0.1.0

Initial release — a community implementation of Claude Code for VS Code on the
Claude Agent SDK.

- Agentic chat panel (activity bar view + editor-tab mode) with streaming responses.
- Full Claude Code toolset via the Agent SDK (Read/Write/Edit/Bash/Grep/Glob/…).
- Tool-use cards with inline diffs; per-tool permission prompts and permission modes
  (default / acceptEdits / plan / bypassPermissions).
- Accept/reject edits individually or in bulk.
- Editor context sharing, add-selection/add-file commands, @-file mentions and
  /slash-command autocomplete.
- Model picker (Opus 4.8 / Sonnet 5 / Haiku 4.5), usage & cost indicator.
- Conversation history & resume, stop/interrupt, API-key sign-in via SecretStorage.
