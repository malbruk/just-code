# Publishing Green Code to the VS Code Marketplace

Everything here is one-time setup except the last section. `npm run publish:check`
blocks a release while any of it is still undone.

> **Publishing is not reversible in the way that matters.** `vsce unpublish` removes the
> listing, but the extension name `<publisher>.green-code` stays claimed. Get the identity
> right before the first push.

---

## 1. Create a publisher

The marketplace identifies extensions as `<publisher>.<name>`. `publisher` is not a free
string — it must be an ID you own.

1. Sign in to <https://marketplace.visualstudio.com/manage> with a Microsoft account.
   This creates an Azure DevOps organisation behind the scenes; you do not have to use it.
2. **Create publisher.** Pick an ID (lowercase, hyphens allowed — e.g. `malbruk`).
   The display name can be anything.
3. Put that ID in `package.json`:

   ```json
   "publisher": "your-publisher-id"
   ```

## 2. Create a Personal Access Token

`vsce` authenticates with a PAT, not your password.

1. Go to <https://dev.azure.com> → user menu → **Personal access tokens** → **New Token**.
2. Set:
   - **Organization:** `All accessible organizations` ← this is the step people miss;
     a token scoped to one org will fail with a confusing 401.
   - **Scopes:** `Custom defined` → find **Marketplace** → tick **Manage**.
   - **Expiration:** up to 1 year.
3. Copy the token. It is shown exactly once.

Store it, then log in:

```bash
npx @vscode/vsce login your-publisher-id
# paste the PAT when prompted
```

## 3. Create the GitHub repository

The marketplace page links to `repository`, `bugs`, and `homepage`. Right now they point at
`github.com/community/green-code`, which does not exist — those links would 404.

```bash
gh repo create <owner>/green-code --public --source . --remote origin --push
```

Then update `package.json`:

```json
"repository": { "type": "git", "url": "https://github.com/<owner>/green-code.git" },
"bugs":       { "url": "https://github.com/<owner>/green-code/issues" },
"homepage":   "https://github.com/<owner>/green-code#readme"
```

## 4. Read this before you publish

Two things about this extension deserve a decision, not a default.

**Authentication.** `green-code.authMethod` defaults to `subscription`, which drives
`claude auth login` from inside the extension. Anthropic's
[Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance)
policy currently says developers building on the Agent SDK "should use API key
authentication", and that Anthropic "does not permit third-party developers to offer
Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf
of their users", reserving the right to enforce "without prior notice."

Green Code routes nothing on anyone's behalf — it invokes Anthropic's own runtime with the
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

## 5. Publish

```bash
npm run publish:check      # blocks on placeholders, stale changelog, bundled binary
npm run publish:marketplace
```

`publish:marketplace` runs the preflight and then `vsce publish`. To cut a new version:

```bash
npm version patch          # or minor / major — bumps package.json
# add a "## <version>" section to CHANGELOG.md
npm run publish:marketplace
```

The listing appears within a few minutes; the search index takes longer.

## 6. Open VSX (optional)

Cursor, VSCodium, and Windsurf use [Open VSX](https://open-vsx.org), not the Microsoft
marketplace. Publishing there is separate:

```bash
npx ovsx publish green-code-<version>.vsix -p <open-vsx-token>
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
