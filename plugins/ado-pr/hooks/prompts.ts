import type { PrComment, PrSnapshot, RepoBranch } from '../types'

import type { BuildFailure } from './ado'

/** The tool names as the model sees them. */
export const TOOLS = {
  create: 'mcp__ado-pr__create_pull_request',
  status: 'mcp__ado-pr__pull_request_status',
  logs: 'mcp__ado-pr__build_failure_logs',
  reply: 'mcp__ado-pr__reply_to_pr_comment',
} as const

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

export function createPrPrompt(branch: RepoBranch): string {
  return [
    `Create an Azure DevOps pull request for the branch \`${branch.branch}\` (${branch.project}/${branch.repo}).`,
    '',
    '1. Commit any uncommitted work that belongs on this branch (skip files that should not be committed), then push it with `git push -u origin HEAD`.',
    '2. Read `git log` and the diff against the target branch, and write a concise PR title and a Markdown description (what changed, why, how it was tested).',
    `3. Call the \`${TOOLS.create}\` tool with that title and description. Leave targetBranch empty to use the repository's default branch.`,
    '',
    'Do not run `az repos pr create` yourself; the tool binds the PR to this session.',
  ].join('\n')
}

export function buildFailurePrompt(pr: PrSnapshot, failure: BuildFailure): string {
  const steps = failure.steps.map(step => {
    const errors = [...new Set([...step.issues, ...step.errors])].slice(0, 25)
    const tail = step.tail.slice(-40)

    return [
      `### Step: ${step.name}`,
      errors.length ? ['Errors:', ...errors.map(line => `- ${clip(line, 400)}`)].join('\n') : '',
      tail.length ? ['Log tail:', '```', ...tail.map(line => clip(line, 400)), '```'].join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n')
  })

  return [
    `The build validation **${failure.pipeline}** (build ${failure.buildId}) failed on Azure DevOps PR #${pr.id} "${pr.title}".`,
    `Build: ${failure.url}`,
    '',
    ...(steps.length ? steps : ['No failed task was found in the timeline; open the build link for details.']),
    '',
    'Find the cause, fix it on this branch, run the relevant checks locally if possible, then commit and push. ',
    `If the failure is unrelated to this PR (flaky test, agent problem), say so and do not change code. \`${TOOLS.logs}\` returns the logs again.`,
  ].join('\n')
}

export function commentsPrompt(pr: PrSnapshot, comments: readonly PrComment[]): string {
  const list = comments.map(comment => {
    const where = comment.file ? ` on \`${comment.file}${comment.line ? `:${comment.line}` : ''}\`` : ''

    return `- Thread ${comment.threadId}, ${comment.author}${where}:\n  > ${clip(comment.text, 1500).replace(/\n/g, '\n  > ')}`
  })

  return [
    `Azure DevOps PR #${pr.id} "${pr.title}" has ${comments.length} unresolved review comment${comments.length === 1 ? '' : 's'}:`,
    '',
    ...list,
    '',
    'Address each one: change the code where the comment asks for it, then commit and push.',
    `Reply to every thread with \`${TOOLS.reply}\` saying what you did (resolve: true when it is handled; leave it open and explain when you disagree or need the author's input).`,
  ].join('\n')
}

/** What `pull_request_status` answers: this chat's PRs as compact text for the model. */
export function statusText(prs: readonly PrSnapshot[], branch: RepoBranch | null): string {
  if (!branch) {
    return 'This session is not in an Azure Repos clone (origin is not dev.azure.com / visualstudio.com).'
  }
  if (prs.length === 0) {
    return `No pull request is bound to this chat (current branch ${branch.branch} in ${branch.project}/${branch.repo}). Create one with ${TOOLS.create}, or ask the person to press Find PR.`
  }

  return JSON.stringify(
    prs.map(pr => ({
      id: pr.id,
      title: pr.title,
      url: pr.url,
      status: pr.status,
      isDraft: pr.isDraft,
      source: pr.sourceBranch,
      target: pr.targetBranch,
      mergeStatus: pr.mergeStatus,
      autoComplete: pr.isAutoComplete,
      lines: { added: pr.additions, removed: pr.deletions },
      checks: pr.checks.map(({ name, state, kind, buildId, isBlocking }) => ({ name, state, kind, buildId, isBlocking })),
      reviewers: pr.votes,
      unresolvedComments: pr.comments,
    })),
    null,
    2,
  )
}

export function failureText(failure: BuildFailure): string {
  return [
    `${failure.pipeline} — build ${failure.buildId} — ${failure.url}`,
    ...failure.steps.flatMap(step => [
      '',
      `## ${step.name}`,
      ...step.issues.map(line => `issue: ${line}`),
      ...step.errors.map(line => `error: ${line}`),
      '--- tail ---',
      ...step.tail,
    ]),
  ].join('\n')
}
