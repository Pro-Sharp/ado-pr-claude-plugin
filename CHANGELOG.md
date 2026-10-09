# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- CI menu: build validation and status checks with counts and run links, policy and reviewer summary, and the **Auto-fix CI & address comments**, **Auto-merge when ready** (Azure DevOps auto-complete) and **Auto-archive on merge or close** switches.
- **Create PR** button and `/ado-pr create`: Claude pushes the branch, writes the title and description, and opens the PR.
- Claude's tools: `create_pull_request`, `pull_request_status`, `build_failure_logs`, `reply_to_pr_comment`.
- `/ado-pr` commands: `status`, `refresh`, `create`, `link`, `unlink`, `fix`, `comments`, `mine`, `show`.
- `/ado-pr mine` pane listing your PRs in the project.
- Polling (`pollSeconds`), plus a refresh after `git push` / `checkout` / `az repos pr` commands.
- On Windows, `az` starts in UTF-8 mode so accented names display correctly.

[Unreleased]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Pro-Sharp/ado-pr-claude-plugin/releases/tag/v0.2.0
