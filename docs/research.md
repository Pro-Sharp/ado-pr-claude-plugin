# Research: Claude Code's GitHub PR integration, and what a mod can reproduce

These notes were taken on 2026-10-09 against Claude Code 2.1.293 (desktop Code tab, Windows). They record where the ado-pr design came from, and what to re-check when Claude Code changes.

## Is the source open?

| Piece | Public? | Where |
|---|---|---|
| Claude Code engine (CLI) | No. Only the built-in **mods** are published. | [`anthropics/claude-code`](https://github.com/anthropics/claude-code), folder `mods/` (`agents-md`, `diff`, `sec-default`, `telemetry`, plus `types/`) |
| Example mods | Yes | [`anthropics/claude-code-playground`](https://github.com/anthropics/claude-code-playground), folder `claude-code/mods/` (`token-weather`, `blast-radius`, `replay-theater`) |
| Claude Desktop app, including the GitHub PR bar, CI dropdown and sidebar badges | **No** | Closed source, shipped inside the desktop app |

The GitHub PR bar is **not** a mod. It is part of the desktop app's own UI, so there is nothing to fork. ado-pr re-implements the same experience on the public mod API and borrows the published mods' idioms: the `diff` mod's use of `$.process.run` for `git`, `$.state` atoms, `command.register` + `command.run`, and `claude plugin test` with hooks standing in for the outside world.

### Keeping up with upstream

Nothing can be merged from upstream because no PR-bar code is published. What does change is the **mod API**, which is still early access. To keep up:

1. Watch `anthropics/claude-code` → `mods/types/` and the Claude Code changelog.
2. After a Claude Code update, load the mod once. The engine rewrites `plugins/ado-pr/.claude-plugin/types/` for the new build. Then run:
   ```bash
   tsc -p plugins/ado-pr
   ```
   ```bash
   claude plugin validate plugins/ado-pr
   ```
   ```bash
   claude plugin test plugins/ado-pr
   ```
3. If Anthropic ever publishes the GitHub PR bar as a built-in mod in `anthropics/claude-code/mods/`, ado-pr's UI layer (`hooks/register.tsx`) can be rebased onto it. The Azure layer (`hooks/ado.ts`, `hooks/status.ts`, `hooks/remote.ts`) is already separate from the UI for that reason.

## How the built-in GitHub integration works

What can be seen from the outside, through the published type declarations and the tools the desktop gives Claude:

- **The `gh` CLI does the work.** Claude runs `gh pr create`, `gh pr view` and so on through its Bash tool. The engine classifies each git/gh command it sees and attaches a structured `gitOperation` record to the Bash result (`commit`, `push`, `branch`, and `pr: { number, url, action: created | merged | closed | auto-merge-enabled | … }`). The desktop reads that record to discover a PR without parsing stdout.
- **The desktop binds the PR to the session.** It has its own session tools (`bind_pr`, `get_status`, `set_auto_merge`, `set_monitor`, `unbind_pr`). These are desktop tools, not mod APIs, and they speak only GitHub.
- **Events arrive by webhook.** A GitHub relay delivers subscribed events (`pull_request.closed`, `check_suite`, review comments) to the session as external-event wakes (`source: github`). Auto-fix and address-comments start a turn from those wakes. Auto-archive archives the session when a merge or close arrives.
- **The sidebar badge** comes from the same binding and is drawn by the desktop shell.

## What the mod API gives us

| Need | Mod API | Used for |
|---|---|---|
| A bar above the prompt | `ui.render` on `AbovePrompt` (terminal and desktop) | PR bar and CI menu |
| A list view | `$.ui.open` + `ui.render` on `Pane` | `/ado-pr mine` |
| Run `az` and `git` | `$.process.run(argv)`: no shell, runs as you | Every Azure DevOps call |
| Session state that survives hot reloads | `$.state` atoms, declared in `types/index.d.ts` | PR snapshot, toggles, handled items |
| Polling | `$.clock.every` started in `session.start` | Refreshes |
| Start a turn | `$.prompt.submit` | Create PR, auto-fix, address comments, archive |
| Give Claude tools | `$.tool.register` + `tool.call` hooks | `create_pull_request`, `pull_request_status`, `build_failure_logs`, `reply_to_pr_comment` |
| React to Claude's commands | `tool.call` on `Bash`, after `next(e)` | Refresh after `git push` / `az repos pr` |
| Toasts and status | `$.ui.toast`, `$.ui.status` | Merge notices |

What it does **not** give us:

- The desktop sidebar. A mod cannot draw there.
- A session-archive call. In the desktop app, Claude has a session-archive tool. ado-pr asks Claude to call it and falls back to a toast elsewhere.
- Inbound webhooks. Azure DevOps service hooks would need a public endpoint, so ado-pr polls.

## Gotchas found while building it

- **`$` must not be stored or passed around freely.** The mod validator rejects storing `$` in a variable, and it accepts passing `$` only to functions declared at the top level of the module. A `$` stays valid only for the dispatch that handed it over, so the refresh queue runs each caller's read with that caller's own `$`.
- **Tool arguments arrive on `e` itself** (`e.title`), beside the reserved `tool` and `tool_use_id`, not under `e.input`.
- **`az` on Windows prints in the console code page.** `az.cmd` starts its bundled Python with `-I` (isolated mode), which ignores `PYTHONIOENCODING` and `PYTHONUTF8`, so names like `Ágnes Példa` come out mangled. ado-pr starts that same `python.exe` itself with `-X utf8 -IBm azure.cli`.
- **`az` reads `@file` arguments.** Titles, descriptions and REST bodies are written to files under `.git/` and passed as `@path`, so no user text ever crosses `cmd.exe` quoting.
