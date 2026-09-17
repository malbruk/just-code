<!-- .claude/commands/handle-issue.md -->
---
description: Handle a GitHub issue end-to-end (branch, code, tests, PR)
argument-hint: <issue-number>
allowed-tools: Bash(git*), Bash(gh*), Bash(npm*), Read, Edit, Write, Grep, Glob
---

Handle GitHub issue #$ARGUMENTS from start to finish.

## Steps

1. Read the requirements: run `gh issue view $ARGUMENTS`.
2. Make sure you're on an up-to-date main: `git checkout main && git pull`.
3. Create a descriptive branch: `fix/<short-slug>-$ARGUMENTS`.
4. Implement the code changes required by the issue. Explore the relevant files first with Grep/Glob/Read before editing.
5. Run the test suite. If any test fails, fix it and re-run until all pass.
6. Commit with a clear message referencing the issue (e.g. `fix: <summary> (#$ARGUMENTS)`).
7. Push the branch: `git push -u origin <branch>`.
8. Open a PR with `gh pr create`, using a title and body that summarize the change and link the issue with `Closes #$ARGUMENTS`.

## Rules

- Do NOT merge. Stop after the PR is open and report the PR URL back to me — I merge myself.
- If the issue is ambiguous or underspecified, ask me before writing code rather than guessing.
- Keep the change scoped to what the issue asks for; don't refactor unrelated code.
- If tests can't be made to pass, stop and report what's blocking rather than forcing a workaround.