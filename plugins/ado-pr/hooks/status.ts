import type { CheckState, PrCheck, PrComment, PrSnapshot, PrStatus } from '../types'

/** What the CI dot shows: the worst state among the PR's CI checks. */
export type Rollup = 'none' | 'passed' | 'failed' | 'running'

type Json = Record<string, any>

const POLICY_STATES: Record<string, CheckState> = {
  approved: 'passed',
  rejected: 'failed',
  broken: 'failed',
  running: 'running',
  queued: 'queued',
  notApplicable: 'skipped',
}

const CI_POLICY_TYPES = new Set(['build', 'status'])

/** Maps `az repos pr policy list` rows to the menu's checks. */
export function checksOf(evaluations: readonly Json[]): PrCheck[] {
  return evaluations.map(evaluation => {
    const config = evaluation.configuration ?? {}
    const typeName = String(config.type?.displayName ?? 'Policy')
    const settings = config.settings ?? {}
    const isCi = CI_POLICY_TYPES.has(typeName.toLowerCase())
    const buildId = Number(evaluation.context?.buildId) || null

    const name =
      settings.displayName ||
      (isCi && settings.statusName ? `${settings.statusGenre ? `${settings.statusGenre}/` : ''}${settings.statusName}` : '') ||
      typeName

    return {
      id: String(evaluation.evaluationId ?? `${typeName}-${config.id ?? ''}`),
      name: String(name),
      state: POLICY_STATES[evaluation.status] ?? 'queued',
      isBlocking: config.isBlocking !== false,
      buildId,
      kind: isCi ? 'ci' : 'policy',
    }
  })
}

export function rollupOf(checks: readonly PrCheck[]): Rollup {
  const ci = checks.filter(check => check.kind === 'ci')

  if (ci.length === 0) {
    return 'none'
  }
  if (ci.some(check => check.state === 'failed')) {
    return 'failed'
  }
  if (ci.some(check => check.state === 'running' || check.state === 'queued')) {
    return 'running'
  }

  return 'passed'
}

/** Counts per state, in the order the menu lists them. */
export function tallyOf(checks: readonly PrCheck[]): [CheckState, number][] {
  const order: CheckState[] = ['failed', 'running', 'queued', 'passed', 'skipped']

  return order
    .map(state => [state, checks.filter(check => check.state === state).length] as [CheckState, number])
    .filter(([, count]) => count > 0)
}

/** Active human review threads; system threads (votes, pushes, policy) are left out. */
export function commentsOf(threads: readonly Json[]): PrComment[] {
  return threads
    .filter(thread => !thread.isDeleted && (thread.status === 'active' || thread.status === 'pending'))
    .filter(thread => !thread.properties?.CodeReviewThreadType)
    .map(thread => {
      const first = (thread.comments ?? []).find((c: Json) => c.commentType !== 'system' && !c.isDeleted)

      return first
        ? {
            threadId: Number(thread.id),
            author: String(first.author?.displayName ?? 'someone'),
            text: String(first.content ?? ''),
            file: thread.threadContext?.filePath ?? null,
            line: thread.threadContext?.rightFileStart?.line ?? thread.threadContext?.leftFileStart?.line ?? null,
          }
        : null
    })
    .filter((comment): comment is PrComment => comment !== null)
}

export function votesOf(reviewers: readonly Json[]) {
  return {
    approved: reviewers.filter(r => r.vote >= 5).length,
    rejected: reviewers.filter(r => r.vote <= -5).length,
    waiting: reviewers.filter(r => r.vote === 0 && r.isRequired).length,
  }
}

/** `git diff --shortstat` → additions and deletions. */
export function parseShortstat(text: string): { files: number; additions: number; deletions: number } | null {
  if (!/changed/.test(text)) {
    return text.trim() === '' ? { files: 0, additions: 0, deletions: 0 } : null
  }

  return {
    files: Number(/(\d+) files? changed/.exec(text)?.[1] ?? 0),
    additions: Number(/(\d+) insertions?\(\+\)/.exec(text)?.[1] ?? 0),
    deletions: Number(/(\d+) deletions?\(-\)/.exec(text)?.[1] ?? 0),
  }
}

/** What the PR's icon says: open, draft, merged, closed. */
export function phaseOf(pr: Pick<PrSnapshot, 'status' | 'isDraft'>): 'open' | 'draft' | 'merged' | 'closed' {
  if (pr.status === 'completed') {
    return 'merged'
  }
  if (pr.status === 'abandoned') {
    return 'closed'
  }

  return pr.isDraft ? 'draft' : 'open'
}

export const isPrStatus = (value: unknown): value is PrStatus =>
  value === 'active' || value === 'completed' || value === 'abandoned'

/** How long ago, as the GitHub card says it: `now`, `5 min.`, `3 hr.`, `2 days`, `last mo.`, `4 mo.`, `2 yr.` */
export function agoOf(iso: string, now: number): string {
  const then = Date.parse(iso)

  if (!Number.isFinite(then)) {
    return ''
  }

  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  const days = Math.floor(minutes / 1440)

  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min.`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr.`
  if (days < 30) return days === 1 ? 'yesterday' : `${days} days`
  if (days < 60) return 'last mo.'
  if (days < 365) return `${Math.floor(days / 30)} mo.`

  return `${Math.floor(days / 365)} yr.`
}

/** `1264` → `1,264`, as the GitHub bar prints it. */
export const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
