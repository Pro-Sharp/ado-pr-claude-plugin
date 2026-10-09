/** One build validation or status policy on the PR, as the CI menu lists it. */
export type CheckState = 'passed' | 'failed' | 'running' | 'queued' | 'skipped'

export type PrCheck = {
  /** The policy evaluation's id. */
  id: string
  name: string
  state: CheckState
  isBlocking: boolean
  /** The build validation's run, when the policy queued one. */
  buildId: number | null
  /** `build` and `status` policies are CI; the rest (reviewers, comments, ...) are policies. */
  kind: 'ci' | 'policy'
}

/** An active (unresolved) review thread. */
export type PrComment = {
  threadId: number
  author: string
  text: string
  file: string | null
  line: number | null
}

export type PrStatus = 'active' | 'completed' | 'abandoned'

export type PrSnapshot = {
  id: number
  title: string
  /** The PR's page in Azure DevOps. */
  url: string
  orgUrl: string
  project: string
  repo: string
  repoId: string
  status: PrStatus
  isDraft: boolean
  sourceBranch: string
  targetBranch: string
  mergeStatus: string
  isAutoComplete: boolean
  additions: number | null
  deletions: number | null
  files: number | null
  author: string
  /** ISO time the PR was opened. */
  createdAt: string
  checks: PrCheck[]
  comments: PrComment[]
  votes: { approved: number; waiting: number; rejected: number }
  checkedAt: number
}

/** The session's checkout, when its origin is an Azure Repos remote. */
export type RepoBranch = {
  orgUrl: string
  project: string
  repo: string
  branch: string
  hasUpstream: boolean
  /** True on the remote's default branch (origin/HEAD), where no PR is offered. */
  isDefault: boolean
}

/** One row of the /ado-pr mine pane. */
export type MinePr = {
  id: number
  title: string
  repo: string
  status: PrStatus
  isDraft: boolean
  url: string
}

/** A pull request this chat created, found or linked: one bar each, kept across restarts. */
export type PrBinding = { orgUrl: string; id: number }

declare module 'claude-code' {
  interface PluginState {
    'ado-pr': {
      branch: RepoBranch | null
      /** This chat's PRs, in the order they were bound. */
      bindings: PrBinding[]
      /** The last read of each bound PR, in binding order. */
      prs: PrSnapshot[]
      error: string | null
      busy: string | null
      /** The PR whose CI panel is open. */
      openMenu: number | null
      isHidden: boolean
      autoFix: boolean
      autoArchive: boolean
      /** The signed-in person's PRs in the project, for the /ado-pr mine pane. */
      mine: MinePr[] | null
      /** Failed builds and comment threads already handed to Claude. */
      handled: string[]
    }
  }
}
