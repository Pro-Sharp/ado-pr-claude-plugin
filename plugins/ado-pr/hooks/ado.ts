import type { PrSnapshot, RepoBranch } from '../types'

import { parseAdoRemote, shortRef } from './remote'
import { checksOf, commentsOf, isPrStatus, parseShortstat, votesOf } from './status'

type Json = Record<string, any>

export type ExecResult = { exitCode: number; stdout: string; stderr: string }

/** `$.process.run`, narrowed to what this module uses, so tests can stand in. */
export type Exec = (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>

export type AdoHost = {
  exec: Exec
  /** The argv that starts the Azure CLI (`['az']`, or Windows' bundled python). */
  azPrefix: readonly string[]
  cwd: string
  writeFile: (path: string, text: string) => Promise<void>
  now: () => Promise<number>
}

export type CreatePrInput = {
  title: string
  description?: string
  targetBranch?: string
  isDraft?: boolean
  workItems?: string[]
}

export type BuildFailure = {
  buildId: number
  pipeline: string
  url: string
  steps: { name: string; issues: string[]; errors: string[]; tail: string[] }[]
}

const API = '7.1'

/** The first line worth reading from az's stderr, with the usual causes spelled out. */
export function azErrorOf(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^WARNING:/i.test(line))
  const text = lines.find(line => /^ERROR:/i.test(line)) ?? lines[0] ?? 'az failed with no message'

  if (/az login|az devops login|not logged in|TF400813|401(?!\d)|unauthorized/i.test(text)) {
    return 'Not signed in to Azure DevOps: run `az login` (or `az devops login` with a PAT).'
  }
  if (/is misspelled or not recognized|extension.*azure-devops|'repos' is not in the 'az' command group/i.test(text)) {
    return 'The azure-devops extension is missing: run `az extension add --name azure-devops`.'
  }

  return text.replace(/^ERROR:\s*/i, '')
}

/** Sign-in and setup problems apply to every read, so they must not be swallowed as "nothing there". */
const isSetupError = (error: unknown) => /^(Not signed in|The azure-devops extension|Could not start the Azure CLI)/.test(String((error as Error)?.message ?? error))

const orEmpty = <T>(fallback: T) => (error: unknown): T => {
  if (isSetupError(error)) {
    throw error
  }

  return fallback
}

/** Azure DevOps answers a missing PR with TF401180 or a 404; anything else is a real failure. */
const isNotFound = (error: unknown) => /TF401180|TF401019|does not exist|not found|404/i.test(String((error as Error)?.message ?? error))

export function adoOf(host: AdoHost) {
  const git = async (args: readonly string[], timeoutMs = 30_000) => {
    const ran = await host.exec(['git', ...args], { cwd: host.cwd, timeoutMs })

    return { ...ran, out: ran.stdout.trim() }
  }

  /** Runs `az <args> -o json` and parses what it prints; rejects with a readable reason. */
  const az = async <T = any>(args: readonly string[], timeoutMs = 60_000): Promise<T> => {
    let ran: ExecResult

    try {
      ran = await host.exec([...host.azPrefix, ...args, '--only-show-errors', '-o', 'json'], { cwd: host.cwd, timeoutMs })
    } catch (error) {
      throw new Error(
        `Could not start the Azure CLI (${host.azPrefix.join(' ')}): install it from https://aka.ms/azcli. ${String((error as Error)?.message ?? error)}`,
      )
    }

    if (ran.exitCode !== 0) {
      throw new Error(azErrorOf(ran.stderr || ran.stdout))
    }

    const text = ran.stdout.trim()

    return (text === '' ? null : JSON.parse(text)) as T
  }

  /** Writes a UTF-8 file under .git for an `@file` argument, so no text crosses a shell. */
  const scratch = async (name: string, text: string) => {
    const gitDir = (await git(['rev-parse', '--absolute-git-dir'])).out
    // Unique per call: sessions sharing a clone, or two calls at once, never share a file.
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const path = `${gitDir}/ado-pr-${unique}-${name}`
    await host.writeFile(path, text)

    return path
  }

  const invoke = (orgUrl: string, area: string, resource: string, route: Record<string, string | number>, extra: string[] = []) =>
    az([
      'devops', 'invoke',
      '--org', orgUrl,
      '--area', area,
      '--resource', resource,
      '--route-parameters', ...Object.entries(route).map(([k, v]) => `${k}=${v}`),
      '--api-version', API,
      ...extra,
    ])

  /** Lines added and removed between the PR's merge base and its source, from the local clone. */
  const diffStat = async (pr: Json) => {
    const source = pr.lastMergeSourceCommit?.commitId
    const target = pr.lastMergeTargetCommit?.commitId

    if (!source || !target) {
      return null
    }

    const has = async (sha: string) => (await git(['cat-file', '-e', `${sha}^{commit}`])).exitCode === 0

    if (pr.status === 'active' && (!(await has(source)) || !(await has(target)))) {
      await git(['fetch', '--quiet', 'origin', String(pr.sourceRefName), String(pr.targetRefName)], 60_000)
    }

    const stat = await git(['diff', '--shortstat', `${target}...${source}`])

    return stat.exitCode === 0 ? parseShortstat(stat.out) : null
  }

  return {
    git,
    az,

    /** The session's checkout and branch, or `null` outside an Azure Repos clone. */
    async branch(): Promise<RepoBranch | null> {
      const remote = await git(['remote', 'get-url', 'origin'])
      const parsed = remote.exitCode === 0 ? parseAdoRemote(remote.out) : null

      if (!parsed) {
        return null
      }

      const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
      const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      const originHead = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      const name = head.exitCode === 0 ? head.out : 'HEAD'
      const defaultBranch = originHead.exitCode === 0 ? originHead.out.replace(/^origin\//, '') : null

      return {
        orgUrl: parsed.orgUrl,
        project: parsed.project,
        repo: parsed.repo,
        branch: name,
        hasUpstream: upstream.exitCode === 0,
        isDefault: name === 'HEAD' || (defaultBranch ? name === defaultBranch : /^(main|master)$/.test(name)),
      }
    },

    /** Which repository a PR belongs to, or `null` when the organization has no such PR. */
    async describe(orgUrl: string, id: number): Promise<{ id: number; repo: string; project: string } | null> {
      const pr = await az<Json>(['repos', 'pr', 'show', '--org', orgUrl, '--id', String(id)]).catch((error: unknown) => {
        if (isNotFound(error)) {
          return null
        }

        throw error
      })

      return pr ? { id, repo: String(pr.repository?.name ?? ''), project: String(pr.repository?.project?.name ?? '') } : null
    },

    /** Everything the band and the menu draw, read in parallel. */
    async snapshot(orgUrl: string, id: number): Promise<PrSnapshot> {
      const pr = await az<Json>(['repos', 'pr', 'show', '--org', orgUrl, '--id', String(id)])
      const project = String(pr.repository?.project?.name ?? '')
      const repoId = String(pr.repository?.id ?? '')

      const [evaluations, threads, stat] = await Promise.all([
        az<Json[]>(['repos', 'pr', 'policy', 'list', '--org', orgUrl, '--id', String(id)]).catch(orEmpty([] as Json[])),
        invoke(orgUrl, 'git', 'pullRequestThreads', { project, repositoryId: repoId, pullRequestId: id })
          .then((r: Json) => (r?.value ?? []) as Json[])
          .catch(orEmpty([] as Json[])),
        diffStat(pr),
      ])

      const checks = checksOf(evaluations ?? [])

      // A build validation names its pipeline only on the build itself.
      await Promise.all(
        checks
          .filter(check => check.kind === 'ci' && check.buildId !== null && /^build$/i.test(check.name))
          .map(async check => {
            const build = await az<Json>(['pipelines', 'build', 'show', '--org', orgUrl, '--project', project, '--id', String(check.buildId)]).catch(
              () => null,
            )
            if (build?.definition?.name) {
              check.name = String(build.definition.name)
            }
          }),
      )

      const webUrl = String(pr.repository?.webUrl ?? `${orgUrl}/${project}/_git/${pr.repository?.name}`)

      return {
        id,
        title: String(pr.title ?? ''),
        url: `${webUrl}/pullrequest/${id}`,
        orgUrl,
        project,
        repo: String(pr.repository?.name ?? ''),
        repoId,
        status: isPrStatus(pr.status) ? pr.status : 'active',
        isDraft: pr.isDraft === true,
        sourceBranch: shortRef(String(pr.sourceRefName ?? '')),
        targetBranch: shortRef(String(pr.targetRefName ?? '')),
        mergeStatus: String(pr.mergeStatus ?? ''),
        isAutoComplete: Boolean(pr.autoCompleteSetBy),
        additions: stat?.additions ?? null,
        deletions: stat?.deletions ?? null,
        files: stat?.files ?? null,
        author: String(pr.createdBy?.displayName ?? ''),
        createdAt: String(pr.creationDate ?? ''),
        checks,
        comments: commentsOf(threads),
        votes: votesOf(pr.reviewers ?? []),
        checkedAt: await host.now(),
      }
    },

    async create(branch: RepoBranch, input: CreatePrInput): Promise<number> {
      const args = [
        'repos', 'pr', 'create',
        '--org', branch.orgUrl,
        '--project', branch.project,
        '--repository', branch.repo,
        '--source-branch', branch.branch,
        '--title', `@${await scratch('title.txt', input.title)}`,
      ]

      if (input.description) {
        args.push('--description', `@${await scratch('description.md', input.description)}`)
      }
      if (input.targetBranch) {
        args.push('--target-branch', input.targetBranch)
      }
      if (input.isDraft) {
        args.push('--draft', 'true')
      }
      if (input.workItems?.length) {
        args.push('--work-items', ...input.workItems)
      }

      const pr = await az<Json>(args)

      return Number(pr.pullRequestId)
    },

    /** Turns Azure DevOps auto-complete on (merge once every policy passes) or off. */
    setAutoComplete(orgUrl: string, id: number, isOn: boolean, strategy: string, deleteSourceBranch: boolean) {
      const args = ['repos', 'pr', 'update', '--org', orgUrl, '--id', String(id), '--auto-complete', String(isOn)]

      if (isOn) {
        args.push('--squash', String(strategy === 'squash'), '--delete-source-branch', String(deleteSourceBranch))
      }

      return az(args)
    },

    setDraft(orgUrl: string, id: number, isDraft: boolean) {
      return az(['repos', 'pr', 'update', '--org', orgUrl, '--id', String(id), '--draft', String(isDraft)])
    },

    /** The failed steps of a build: their issues, `##[error]` lines and the log's tail. */
    async buildFailure(orgUrl: string, project: string, buildId: number): Promise<BuildFailure> {
      const build = await az<Json>(['pipelines', 'build', 'show', '--org', orgUrl, '--project', project, '--id', String(buildId)])
      const timeline = await invoke(orgUrl, 'build', 'timeline', { project, buildId })
      const failed = ((timeline?.records ?? []) as Json[]).filter(r => r.result === 'failed' && r.type === 'Task')

      const steps = await Promise.all(
        failed.slice(0, 4).map(async record => {
          const logId = record.log?.id
          const log = logId
            ? await invoke(orgUrl, 'build', 'logs', { project, buildId, logId }, [
                '--query', "{tail: value[-80:], errors: value[?contains(@, '##[error]')] | [:40]}",
              ]).catch(() => null)
            : null

          return {
            name: String(record.name),
            issues: ((record.issues ?? []) as Json[]).map(issue => String(issue.message)).slice(0, 20),
            errors: (log?.errors ?? []) as string[],
            tail: (log?.tail ?? []) as string[],
          }
        }),
      )

      return {
        buildId,
        pipeline: String(build?.definition?.name ?? 'pipeline'),
        url: `${orgUrl}/${project}/_build/results?buildId=${buildId}`,
        steps,
      }
    },

    /** Replies on a review thread, and marks it fixed when asked. */
    async reply(pr: PrSnapshot, threadId: number, text: string, resolve: boolean) {
      const route = { project: pr.project, repositoryId: pr.repoId, pullRequestId: pr.id, threadId }
      const body = await scratch('reply.json', JSON.stringify({ content: text, parentCommentId: 1, commentType: 1 }))

      await invoke(pr.orgUrl, 'git', 'pullRequestThreadComments', route, ['--http-method', 'POST', '--in-file', body])

      if (resolve) {
        const status = await scratch('status.json', JSON.stringify({ status: 'fixed' }))
        await invoke(pr.orgUrl, 'git', 'pullRequestThreads', route, ['--http-method', 'PATCH', '--in-file', status])
      }
    },

    /** The signed-in person's PRs in a project, newest first. */
    async mine(orgUrl: string, project: string): Promise<Json[]> {
      const account = (await az<Json>(['account', 'show']))?.user
      // A service principal's name is an app id, which --creator does not resolve.
      const me = account?.type === 'servicePrincipal' ? undefined : account?.name

      return (
        (await az<Json[]>([
          'repos', 'pr', 'list',
          '--org', orgUrl,
          '--project', project,
          '--status', 'all',
          '--top', '30',
          ...(me ? ['--creator', String(me)] : []),
        ])) ?? []
      )
    },
  }
}

export type Ado = ReturnType<typeof adoOf>
