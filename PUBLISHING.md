# Publishing Just Code to the VS Code Marketplace

The publisher (`MaBrukDev`) and the Entra ID credential (Option A) are set up and reusable.
The rest of sections 1–3 is **not** carried over from the old name: renaming the extension
from Yes Code to Just Code changed `name` from `yescode` to `just-code`, so
`MaBrukDev.just-code` is a **new listing** whose first publish claims that name permanently,
and `github.com/malbruk/just-code` must exist before the marketplace page can link to it.
Once both are true, a release is [section 5](#5-cutting-and-publishing-a-new-version).

> The old listing, `MaBrukDev.yescode`, keeps running for whoever installed it. It will
> never see the rename: an extension id is its identity on the marketplace, so existing
> users get no update, and their `yes-code.*` settings and keybindings do not carry over.
> Deprecate it deliberately rather than leaving two live listings.

> **Publishing is not reversible in the way that matters.** `vsce unpublish` removes the
> listing, but the extension name `<publisher>.<name>` stays claimed. Get the identity
> right before the first push.

---

## 1. Create a publisher

The marketplace identifies extensions as `<publisher>.<name>`. `publisher` is not a free
string — it must be an ID you own.

> **`name` is unique across the whole marketplace, not just within your publisher.** The
> first attempt at this rename used `name: "justcode"` and was rejected at upload with
> *"The extension 'justcode' already exists in the Marketplace"* — `psxcode.justcode`, an
> unrelated colour theme, holds it. Hence `just-code`. `displayName` carries no such
> constraint; several extensions are called "JustCode". Check a candidate before you plan
> around it: `npx @vscode/vsce search <name>`.

1. Sign in to <https://marketplace.visualstudio.com/manage> with a Microsoft account.
   This creates an Azure DevOps organisation behind the scenes; you do not have to use it.
2. **Create publisher.** Pick an ID (lowercase, hyphens allowed — e.g. `malbruk`).
   The display name can be anything.
3. Put that ID in `package.json`:

   ```json
   "publisher": "your-publisher-id"
   ```

## 2. Authenticate

`vsce` does not use your password. There are two mechanisms, and **the older one has an
expiry date**.

> **Global PATs are retired on 1 December 2026.** A PAT scoped to
> `All accessible organizations` *is* a global PAT — that is Microsoft's own definition.
> Creating them still works until that date ([the March 2026 block was cancelled](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/)),
> but every existing one stops working afterwards. The
> [VS Code docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
> now say: *"To keep publishing extensions, use secure automated publishing with Microsoft
> Entra ID instead of PATs."*

### Option A — Microsoft Entra ID (no expiry cliff)

Supported by `vsce` ≥ 2.26.1 (we are on 3.9.2). Sign in with Azure CLI, then publish:

```bash
az login
npm run publish:marketplace     # → vsce publish --azure-credential
```

For CI, Microsoft recommends workload identity federation or a managed identity rather than
a stored secret. Note that `--azure-credential` with a **service principal** has known rough
edges — see [vscode-vsce#1023](https://github.com/microsoft/vscode-vsce/issues/1023) and
[#976](https://github.com/microsoft/vscode-vsce/issues/976) before wiring up a pipeline.

### Option B — Personal Access Token (works until 1 Dec 2026)

Simpler for a first manual publish. Just know it is a dead end.

1. Go to <https://dev.azure.com> → user menu → **Personal access tokens** → **New Token**.
2. Set:
   - **Organization:** `All accessible organizations` ← required; a token scoped to a single
     org fails with a confusing 401. This is also precisely what makes it a *global* PAT.
   - **Scopes:** `Custom defined` → scroll to **Marketplace** → tick **Manage**.
   - **Expiration:** up to 1 year — but it will stop working on 1 Dec 2026 regardless.
3. Copy the token. It is shown exactly once.

```bash
npx @vscode/vsce login your-publisher-id
# paste the PAT when prompted
npm run publish:marketplace:pat   # → vsce publish   (no --azure-credential)
```

`vsce login` only accepts a PAT. Entra has no login step — the credential is picked up from
your `az login` session (or a managed identity in CI).

## 3. Create the GitHub repository

The marketplace page links to `repository`, `bugs`, and `homepage`, so they must resolve.
Preflight blocks on a placeholder URL, but it cannot tell a live URL from a dead one.

Done: the repository was renamed on GitHub from `yes-code` to `just-code`, and
`package.json` points at it. If a clone still has the old remote, GitHub redirects it, so
pushes keep working — but repoint it anyway:

```bash
git remote set-url origin git@github.com:malbruk/just-code.git
```

Preflight warns (does not fail) when the git remote and `package.json` `repository`
disagree, which is exactly what an un-repointed clone looks like.

## 4. Read this before you publish

Two things about this extension deserve a decision, not a default.

**Authentication.** `just-code.authMethod` defaults to `subscription`, which drives
`claude auth login` from inside the extension. Anthropic's
[Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance)
policy currently says developers building on the Agent SDK "should use API key
authentication", and that Anthropic "does not permit third-party developers to offer
Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf
of their users", reserving the right to enforce "without prior notice."

Just Code routes nothing on anyone's behalf — it invokes Anthropic's own runtime with the
user's own local credentials. Whether that distinction holds is not settled. Running it
yourself is ordinary use of your own subscription; *shipping* it to strangers with
subscription login as the default is the exposed position. Switching the default to
`apiKey` is a one-line change in `package.json` and removes the question entirely.

**Trademarks.** `keywords` contains `claude` and `anthropic`. Using them to describe what
the extension integrates with is nominative use and is normal for third-party integrations.
Do not add anything that implies endorsement. The README already carries the non-affiliation
notice required by Anthropic's
[Software Directory Terms](https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms):
*"You will not make any statement regarding the Anthropic Services which suggests
partnership with, sponsorship by, or endorsement by Anthropic."*

## 5. Cutting and publishing a new version

Sections 1–3 are done. This is the whole release, in order. Run every step from the repo
root on `master`, with a clean working tree.

### Step 1 — start from a clean, pushed `master`

```bash
git status --short            # must print nothing
git pull --ff-only origin master
```

### Step 2 — run the verification suite

There is no unit-test runner; these six scripts *are* the suite. All must pass before you
touch the version.

```bash
npm run check-types           # tsc --noEmit, whole project
node esbuild.js               # both bundles must build
node scratch/activate-test.js # every contributes.commands entry is registered
node scratch/binary-test.js   # native `claude` still resolves, in-repo and out-of-tree
node scratch/mcp-test.mjs     # live: stdio MCP server connects, tool executes
node scratch/guardrail-test.mjs  # live: the scope layer still refuses off-topic prompts
```

> `guardrail-test.mjs` runs real turns under `maxTurns: 1`, so it throws
> `Reached maximum number of turns (1)` whenever a case spends its one turn on a tool call
> instead of answering. That is a flake in the test, not a scope regression. **Rerun it**;
> a real failure prints `FAIL` lines and `GUARDRAIL_TEST: FAIL (n/7)`.

### Step 3 — bump the version, without letting npm commit it

`npm version` would commit and tag on its own, splitting the bump from the changelog entry
that has to accompany it. Suppress that:

```bash
npm version patch --no-git-tag-version    # or minor / major
```

### Step 4 — write the changelog section

Add a `## <new-version>` heading to the top of `CHANGELOG.md`, above the previous release.

**Preflight hard-fails without a heading that matches `package.json` exactly** — this is the
single most common thing that blocks a release. It is a literal `^## <version>$` match, so
`## v1.0.4` and `## 1.0.4 — title` both fail.

### Step 5 — commit the bump and the changelog together

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release <version>"
git push origin master
```

### Step 6 — make sure the Entra credential is live

```bash
az account show     # if this errors, run: az login
```

Skip this if you took Option B (PAT); `vsce login` is a one-time step.

### Step 7 — preflight, then publish

```bash
npm run publish:check         # placeholders, stale changelog, bundled binary, LICENSE, icon
npm run publish:marketplace   # re-runs preflight, then vsce publish --azure-credential
```

`publish:marketplace` runs `publish:check` itself, so step 7's first command is only there
to let you see the blockers before anything is uploaded. Use
`npm run publish:marketplace:pat` instead if you took Option B.

Success looks like `DONE  Published <publisher>.<name> v<version>.`

### Step 8 — verify

```bash
npx @vscode/vsce show MaBrukDev.just-code
```

**Expect this to still report the previous version for a few minutes.** `vsce publish`
printing `DONE` is the authoritative signal; `vsce show` reads the search index, which lags
behind the listing. Do not republish because this looks stale.

## 6. Open VSX (optional)

Cursor, VSCodium, and Windsurf use [Open VSX](https://open-vsx.org), not the Microsoft
marketplace. Publishing there is separate:

```bash
npm run vsix                                    # → just-code.vsix
npx ovsx publish just-code.vsix -p <open-vsx-token>
```

---

## Notes on the package itself

- The VSIX is ~1 MB and **platform-independent** — the ~250 MB native `claude` runtime is
  not bundled. Users must install Claude Code separately
  (`npm install -g @anthropic-ai/claude-code`); the extension discovers it at load time.
  This is why no `--target` matrix or per-platform CI is needed.
- `preflight.js` fails if `.vscodeignore` ever re-includes all of `@anthropic-ai/**`,
  which would silently drag the binary back in and inflate the package 80×.
- Before releasing, run the verification suite (see `CLAUDE.md`):
  `check-types`, `esbuild.js`, `scratch/activate-test.js`, `scratch/binary-test.js`,
  `scratch/mcp-test.mjs`, `scratch/guardrail-test.mjs`.
