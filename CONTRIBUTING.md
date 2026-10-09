# Contributing to ado-pr

Thanks for helping. This project is small on purpose: one Claude Code mod, built on `az` and `git`.

## Ground rules

- **Read [docs/research.md](docs/research.md) first.** It explains what the mod API can and cannot do, so you don't spend a weekend on something a mod can't reach, such as the desktop sidebar.
- **Only `az` and `git`.** No direct REST calls with tokens, and no new runtime dependencies. If `az repos` / `az pipelines` lacks a command, use `az devops invoke` with the right `--area` and `--resource`, and add the row to [docs/az-cli-mapping.md](docs/az-cli-mapping.md).
- **No user text through a shell.** Titles, descriptions and request bodies go through `@file` arguments (see `scratch()` in `hooks/ado.ts`).
- **Keep the layers apart.** `hooks/ado.ts`, `hooks/status.ts` and `hooks/remote.ts` never touch `$`. Only `hooks/register.tsx` does.

## Set up

1. Install Claude Code 2.1.287 or later, the Azure CLI, and the extension:
   ```bash
   az extension add --name azure-devops
   ```
2. Clone this repository and run the mod from your clone in any Azure Repos checkout:
   ```bash
   claude --plugin-dir /path/to/ado-pr-claude-plugin/plugins/ado-pr
   ```
   Saving a file reloads the mod in that session. For the desktop app, set `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (see the README).
3. Once the mod has loaded, Claude Code has written `plugins/ado-pr/.claude-plugin/types/`. Type-check against it:
   ```bash
   tsc -p plugins/ado-pr
   ```

## Before you open a PR

```bash
claude plugin validate plugins/ado-pr
```

```bash
claude plugin test plugins/ado-pr
```

CI runs both. Please also:

- add or update a test in `plugins/ado-pr/tests/`. Pure logic goes in `units.test.ts`. UI behaviour goes in `register.test.ts`, mounted on both `terminal` and `desktop`.
- update `docs/az-cli-mapping.md` for any new `az` command, and `README.md` for anything a user sees.
- add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
- try it once against a real Azure DevOps PR, and say in the PR description what you checked.

## Mod API rules you will hit

`claude plugin validate` enforces these, and they're easy to trip on:

- `$` is never stored in a variable. A function that receives `$` must be declared at the top level of the module.
- `$.state` references take literal `plugin` and `key` values (`atom({ plugin: 'ado-pr', key: 'pr' } as const, null)`), and each key is declared in `types/index.d.ts`.
- A `ui.render` hook never writes state. Write from a handler (`onPress`) or from another event.
- A model tool's arguments are fields of `e` itself, not of `e.input`.

## Style

- TypeScript, strict. Two-space indent, no semicolons, single quotes, matching the existing files.
- Doc comments say *what* and *why*, and never narrate the code.
- Commit messages: [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).

## Releasing

Installed copies update only when the version changes, so every release bumps it.

- [ ] `main` is green in CI, and you've tried the release once against a real Azure DevOps PR (bar, hover card, CI popover).
- [ ] `claude plugin validate .` and `claude plugin validate plugins/ado-pr` pass.
- [ ] `claude plugin test plugins/ado-pr` passes.
- [ ] Bump `version` in `plugins/ado-pr/.claude-plugin/plugin.json` ([Semantic Versioning](https://semver.org/): patch for fixes, minor for features, major when an option, command or tool changes or goes away).
- [ ] In `CHANGELOG.md`, rename **Unreleased** to `[X.Y.Z] - YYYY-MM-DD`, add a fresh empty **Unreleased** above it, and update the compare links at the bottom.
- [ ] Commit (`chore(release): vX.Y.Z`), then tag and push:
  ```bash
  git tag vX.Y.Z
  ```
  ```bash
  git push origin main --tags
  ```
- [ ] Create a GitHub release from the tag, with that version's changelog section as its notes.
- [ ] Check the update path from a clean install: `claude plugin marketplace update azure-devops-pr`, then `claude plugin update ado-pr`, then `/reload-plugins`, and confirm the new version shows in `claude plugin list`.
