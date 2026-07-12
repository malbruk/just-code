---
name: release
description: Build, verify, and publish the extension to the VS Code marketplace
---
1. Confirm working tree is clean (`git status`). Abort if dirty.
2. Read PUBLISHING.md and follow the numbered steps exactly.
3. Ensure CHANGELOG.md has an entry for the new version; if missing, write one from the git log since the last tag.
4. Run typecheck + build + tests. Abort on any failure.
5. Package the VSIX and verify it contains no uncommitted code.
6. Publish, then report the marketplace URL.