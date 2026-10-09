# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-09

### Added

- PR bar above the prompt: state icon (open, draft, merged, abandoned), `#id` link, repo, branch, `+/−` lines, CI dot, unresolved comment count.
- CI menu: build validation and status checks with counts and run links, policy and reviewer summary, and the **Auto-fix CI & address comments**, **Auto-merge when ready** (Azure DevOps auto-complete) and **Auto-archive on merge or close** switches.
- **Create PR** button and `/ado-pr create`: Claude pushes the branch, writes the title and description, and opens the PR.
- Claude's tools: `create_pull_request`, `pull_request_status`, `build_failure_logs`, `reply_to_pr_comment`.
- `/ado-pr` commands: `status`, `refresh`, `create`, `link`, `unlink`, `fix`, `comments`, `mine`, `show`.
- `/ado-pr mine` pane listing your PRs in the project.
- Polling (`pollSeconds`), plus a refresh after `git push` / `checkout` / `az repos pr` commands.
- On Windows, `az` starts in UTF-8 mode so accented names display correctly.

[Unreleased]: https://github.com/<github-user>/claude-code-azure-devops-pr/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<github-user>/claude-code-azure-devops-pr/releases/tag/v0.1.0
