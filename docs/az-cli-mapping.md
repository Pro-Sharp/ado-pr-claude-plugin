# Feature → Azure CLI mapping

Every feature of the GitHub PR bar, and the `az` / `git` command ado-pr runs for it. Each command was checked against a live Azure DevOps organization (azure-cli 2.86.0, azure-devops extension 1.0.6). `{org}` is `https://dev.azure.com/<org>`, taken from `origin`.

| Feature | Command | Notes |
|---|---|---|
| Find the repo | `git remote get-url origin` | Parsed for org, project and repo. HTTPS, legacy `*.visualstudio.com` and SSH v3 URLs all work. |
| Current branch | `git rev-parse --abbrev-ref HEAD` | `git symbolic-ref refs/remotes/origin/HEAD` finds the default branch, which gets no Create PR button. |
| Find PR (a chat's own PRs) | the chat's history (`$.session.messages()`) for `/pullrequest/<id>`, `"pullRequestId"`, `PR #<id>` and `az repos pr create` output, then `az repos pr show --org {org} --id N` for each | Only PRs of the checkout's repository are added. A chat never looks a PR up by branch. |
| PR details: title, state, draft, auto-complete, reviewers | `az repos pr show --org {org} --id N` | `status`: `active`, `completed` or `abandoned`. `autoCompleteSetBy` is set when auto-complete is on. |
| `+/−` lines | `git diff --shortstat <lastMergeTargetCommit>...<lastMergeSourceCommit>` | Runs `git fetch origin <src> <tgt>` once if the commits are missing. |
| CI checks and policy status | `az repos pr policy list --org {org} --id N` | `Build` and `Status` policies count as CI. `approved`→passed, `rejected`/`broken`→failed, `running`, `queued`, `notApplicable`→skipped. `context.buildId` links to the run. |
| CI check name | `az pipelines build show --org {org} --project P --id B` | `definition.name` |
| Unresolved comments | `az devops invoke --area git --resource pullRequestThreads --route-parameters project=P repositoryId=R pullRequestId=N --api-version 7.1` | Threads with `status` `active` or `pending` and no `CodeReviewThreadType` property (that property marks system threads). |
| Failed build details (auto-fix) | `az devops invoke --area build --resource timeline --route-parameters project=P buildId=B` | `records[?result=='failed' && type=='Task']`, with their `issues` |
| Failed step log | `az devops invoke --area build --resource logs --route-parameters project=P buildId=B logId=L --query "{tail: value[-80:], errors: value[?contains(@, '##[error]')] \| [:40]}"` | JMESPath trims the output inside `az`, so large logs stay small. |
| Reply on a thread | `az devops invoke --area git --resource pullRequestThreadComments … --http-method POST --in-file reply.json` | Body `{ content, parentCommentId: 1, commentType: 1 }` |
| Resolve a thread | `az devops invoke --area git --resource pullRequestThreads … --http-method PATCH --in-file status.json` | Body `{ status: "fixed" }` |
| Create PR | `az repos pr create --org {org} --project P --repository R --source-branch B --title @title.txt [--description @description.md] [--target-branch T] [--draft true] [--work-items …]` | `@file` keeps user text away from any shell. |
| Auto-merge when ready | `az repos pr update --org {org} --id N --auto-complete true --squash true\|false --delete-source-branch true\|false` | `--auto-complete false` cancels it. |
| Publish a draft | `az repos pr update --org {org} --id N --draft false` | |
| My PRs (the sidebar substitute) | `az account show` then `az repos pr list --org {org} --project P --creator <user> --status all --top 30` | `--creator` takes the signed-in UPN. Listing across the whole organization needs `--project`, so the pane covers the current project. |

## Windows: how `az` is started

`az.cmd` runs `python.exe -IBm azure.cli`. `-I` ignores `PYTHONIOENCODING`, so ado-pr starts the bundled interpreter itself:

```text
"C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe" -X utf8 -IBm azure.cli <args>
```

If no bundled `python.exe` is found and the `azPython` option is empty, it falls back to `cmd /d /c az <args>`.
