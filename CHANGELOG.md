# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-10-09

### Fixed

- A PR created with `az repos pr create` is bound by its own `pullRequestId`, not a PR number its description mentions.
- A build whose logs could not be read is retried on the next read instead of being marked handled; one PR's failure no longer stops the others.
- A review thread that was resolved and then reopened is handed to Claude again by auto-fix.
- Scratch files for `az` are unique per call, so chats sharing a clone cannot overwrite each other's.
- The read queue, throttle and poll timer are kept per chat.
- Sign-in problems are no longer reported as "no such PR" or as an empty policy/comment list; `/ado-pr mine` works for service principals.
- Merged and abandoned PRs are no longer re-read on every poll.
- "Ready to merge" accounts for rejections and required reviewers still waiting; `build_failure_logs` picks the project of the PR that owns the build.

## [0.4.5] - 2026-10-09

### Changed

- The plugin's author is Pro-Sharp, with a contact email and website.

## [0.4.4] - 2026-10-09

### Changed

- The README points to `/ado-pr find` and `/ado-pr link` near the top, and shows the CI panel in the terminal.

### Fixed

- Opening the CI panel no longer scrolls the PR bar out of view. The panel is sized to the rows the band has left: the CI counts sit in its header, the policy summary is one line, and when space is short the check list ends in "+n more" and the policy and ready lines are left out.

## [0.4.3] - 2026-10-09

### Fixed

- On the desktop the CI state sits inside the CI button, as 🟢 / 🔴 / 🟡 before `CI ▾`, instead of a separate dot beside it.
- The CI panel shows whole without scrolling. Its lines no longer wrap: the policy summary is split into three short lines, long ones are cut with an ellipsis, the panel is a little wider, and it has half a row more room at the bottom.

## [0.4.2] - 2026-10-09

### Changed

- **Auto-merge when ready** no longer deletes the source branch by default: `deleteSourceBranch` defaults to `false`. Set it to `true` in `/config` to keep the old behaviour.

## [0.4.1] - 2026-10-09

### Changed

- The plugin is listed as **Azure DevOps Pull Requests Bar** (its id stays `ado-pr`, so installs, commands and saved PRs carry over).
- New merged-PR icon: one stem, with the branch sweeping down and right into its own head (purple, black outline).
- The README shows screenshots of the bar, the hover card, the CI panel, a merged PR and Find PR.

## [0.4.0] - 2026-10-09

### Changed

- On the desktop, the PR bars, and the Create PR row below them, have a small gap between them (0.4 of a row, about 8px).
- **Find PR** shows only in a chat with no PR yet. Once a chat has PRs, the row under them offers **Create PR** alone, and only while none of them is open.

## [0.3.0] - 2026-10-09

### Changed

- **PRs belong to the chat, not the branch.** A chat shows the PRs it created, found or linked, kept per chat across restarts, whatever branch the folder is on. Two chats of the same repository no longer show each other's PR, and a chat never picks a PR up by branch.
- The quick-redraw cache is per chat instead of per folder.

### Added

- **Several PRs per chat**, one bar each, each with its own branch, hover card and CI panel.
- **Find PR** button and `/ado-pr find`: adds the PRs the chat's history mentions (links, ids, `az repos pr create` output) that belong to this repository. For chats from earlier versions.
- A PR Claude opens with `az repos pr create` is added to the chat.
- **Remove from chat** in each CI panel, and `/ado-pr unlink [id]` for one PR.

## [0.2.4] - 2026-10-09

### Fixed

- The `+/−` chip is the same height as the CI button: 20px, as measured on the desktop (it was 26px in 0.2.3), with 14px bold text and tighter padding.

## [0.2.3] - 2026-10-09

### Fixed

- The `+/−` chip matches the CI button: 26px tall with 14px bold text (was 22px and 12px), and the row no longer squeezes it.

## [0.2.2] - 2026-10-09

### Changed

- Abandoned PRs are orange (icon, badge and `#id`) instead of red.
- The CI panel opens only on click, no longer on hover.
- While the CI panel is open, hovering `#id` no longer opens the summary card, so the bar stops flickering.
- On the desktop, the `+/−` and file-count chips are rounded `#383838` pills in bold monospace, sized to match the CI button and sitting next to it.
- The unresolved-comment count uses an SVG speech bubble (white inside, black outline) instead of an emoji.

## [0.2.1] - 2026-10-09

### Changed

- The `#id` hover card and the CI panel open inside the bar, which grows upward from the prompt. A mod can't draw outside its band, so in 0.2.0 they were cut off.
- The `+/−` and file-count chips are one line tall with a `#383838` background and no border.

## [0.2.0] - 2026-10-09

### Added

- PR state icons drawn as SVG on the desktop: the pull-request icon (green open, grey draft, red abandoned) and the merge icon (purple), each with a black outline.
- Hover card on `#id`, as on GitHub: state badge, `project/repo #id`, age, title, author, `+/−` and file count.

### Changed

- The bar has wider spacing, a code-styled branch name and a rounded box around `+/−` on the desktop.
- The CI menu is a popover over the bar: it opens on hover, a click keeps it open, and it no longer pushes the bar up.

### Fixed

- The bar no longer disappears after you leave a chat and come back. The last snapshot per folder is kept in `$.store` and drawn at once, and a draw with stale data starts a refresh.
- The bar no longer stays empty after a failed first read. Polling now retries even when no branch was ever read, and each prompt and finished turn refreshes as well (throttled).

## 0.1.0 - 2026-10-09

### Added

- PR bar above the prompt: state icon (open, draft, merged, abandoned), `#id` link, repo, branch, `+/−` lines, CI dot, unresolved comment count.
- CI menu: build validation and status checks with counts and run links, policy and reviewer summary, and the **Auto-fix CI & address comments** and **Auto-merge when ready** (Azure DevOps auto-complete) switches.
- **Create PR** button and `/ado-pr create`: Claude pushes the branch, writes the title and description, and opens the PR.
- Claude's tools: `create_pull_request`, `pull_request_status`, `build_failure_logs`, `reply_to_pr_comment`.
- `/ado-pr` commands: `status`, `refresh`, `create`, `link`, `unlink`, `fix`, `comments`, `mine`, `show`.
- `/ado-pr mine` pane listing your PRs in the project.
- Polling (`pollSeconds`), plus a refresh after `git push` / `checkout` / `az repos pr` commands.
- On Windows, `az` starts in UTF-8 mode so accented names display correctly.

[Unreleased]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.4.5...v0.5.0
[0.4.5]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/releases/tag/v0.2.0
