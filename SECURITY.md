# Security policy

ado-pr runs inside Claude Code with your permissions and calls `az` and `git` as you. Please treat security reports seriously and privately.

## Reporting

Use GitHub's **Security → Report a vulnerability** on this repository. Please don't open a public issue. Include the Claude Code version, the OS, and the steps to reproduce. You'll get an answer within a week.

## Design guarantees

- The mod stores, reads and sends **no credentials**. `az` uses its own sign-in (`az login` / `az devops login`).
- No user-written text (PR titles, descriptions, comment replies) is passed through a shell. It goes to `az` as an `@file` argument written under `.git/`.
- It talks only to the organization in your clone's `origin`.
- Text from Azure DevOps (build logs, review comments) is handed to Claude as **data to act on in your repository**, inside a turn you can watch and interrupt. Reviewers can write anything in a comment. If your PRs get comments from people you don't trust, leave **Auto-fix CI & address comments** off.

## Supported versions

Only the latest release gets fixes.
