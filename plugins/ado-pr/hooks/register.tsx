import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CheckState, MinePr, PrBinding, PrSnapshot, RepoBranch } from '../types'

import { adoOf } from './ado'
import type { Ado, CreatePrInput } from './ado'
import { createdPrIdOf, prIdsFromHistory } from './history'
import { CHIP_COLORS, chipSvg, commentSvg, ICON_ALT, iconSvg, PHASE_LABEL } from './icons'
import type { ChipPart } from './icons'
import { buildFailurePrompt, commentsPrompt, createPrPrompt, failureText, statusText } from './prompts'
import { agoOf, isPrStatus, phaseOf, rollupOf, tallyOf, thousands } from './status'

type $ = EngineInterface

const MINE_PANE = 'ado-pr-mine'

const branchAtom = atom({ plugin: 'ado-pr', key: 'branch' } as const, null)
const bindingsAtom = atom({ plugin: 'ado-pr', key: 'bindings' } as const, [])
const prsAtom = atom({ plugin: 'ado-pr', key: 'prs' } as const, [])
const errorAtom = atom({ plugin: 'ado-pr', key: 'error' } as const, null)
const busyAtom = atom({ plugin: 'ado-pr', key: 'busy' } as const, null)
const openMenuAtom = atom({ plugin: 'ado-pr', key: 'openMenu' } as const, null)
const hiddenAtom = atom({ plugin: 'ado-pr', key: 'isHidden' } as const, false)
const autoFixAtom = atom({ plugin: 'ado-pr', key: 'autoFix' } as const, false)
const mineAtom = atom({ plugin: 'ado-pr', key: 'mine' } as const, null)
const handledAtom = atom({ plugin: 'ado-pr', key: 'handled' } as const, [])

const STATE_ICON: Record<CheckState, string> = {
  passed: '✓',
  failed: '✗',
  running: '◔',
  queued: '○',
  skipped: '○',
}

const STATE_LABEL: Record<CheckState, string> = {
  passed: 'Passed',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
  skipped: 'Skipped',
}

const STATE_COLOR: Record<CheckState, string> = {
  passed: 'success',
  failed: 'error',
  running: 'warning',
  queued: 'inactive',
  skipped: 'inactive',
}

const PHASE_COLOR = { open: 'success', draft: 'inactive', merged: 'merged', closed: 'warning' } as const

/** The CI state inside the CI button's label on the desktop: an emoji keeps its own colour where a label's text cannot have one. */
const CI_DOT = { passed: '🟢', failed: '🔴', running: '🟡' } as const

/** The space between two bars on the desktop, in rows: about 8px (a row is ~20px there). */
const ROW_GAP = 0.4

/** The hover group of one PR's #id and its card. */
const cardScopeOf = (id: number) => `ado-pr-card-${id}`

const messageOf = (error: unknown) => String((error as Error)?.message ?? error)

/** The manifest's userConfig, as register received it. */
const config = { pollSeconds: 60, mergeStrategy: 'squash', deleteSourceBranch: false, azPython: '' }

let azPrefix: readonly string[] | null = null

/** The read queue, throttle and poll timer of one chat; the module may serve several. */
type SessionState = { tail: Promise<void>; waiting: number; lastKickAt: number; poll: Timer | null }

const states = new Map<string, SessionState>()

async function stateOf($: $): Promise<SessionState> {
  const id = await $.session.id()
  let state = states.get(id)

  if (!state) {
    state = { tail: Promise.resolve(), waiting: 0, lastKickAt: 0, poll: null }
    states.set(id, state)
  }

  return state
}

/**
 * A chat's PRs are kept in `$.store` under its session id (the transcript's
 * name), so they outlive restarts and never leak into another chat of the
 * same folder; the last snapshots beside them draw a re-opened chat at once.
 */
const bindingsKeyOf = (sessionId: string) => `bindings:${sessionId}`
const snapshotsKeyOf = (sessionId: string) => `snapshots:${sessionId}`

const isBinding = (value: unknown): value is PrBinding =>
  typeof value === 'object' && value !== null && typeof (value as PrBinding).id === 'number' && typeof (value as PrBinding).orgUrl === 'string'

async function storedBindings($: $): Promise<PrBinding[]> {
  try {
    const value = await $.store.get(bindingsKeyOf(await $.session.id()))

    return Array.isArray(value) ? value.filter(isBinding) : []
  } catch {
    return []
  }
}

async function saveBindings($: $, bindings: PrBinding[]) {
  await update($, bindingsAtom, () => bindings)
  await $.store.set(bindingsKeyOf(await $.session.id()), bindings).catch(() => undefined)
}

/** Adds a PR to this chat (once) and shows its bar. */
async function bind($: $, binding: PrBinding) {
  const bindings = await storedBindings($)

  if (!bindings.some(one => one.id === binding.id && one.orgUrl === binding.orgUrl)) {
    await saveBindings($, [...bindings, binding])
  }

  await update($, hiddenAtom, () => false)
}

/** Removes one PR from this chat, or all of them. */
async function unbind($: $, id?: number) {
  const bindings = id === undefined ? [] : (await storedBindings($)).filter(one => one.id !== id)

  await saveBindings($, bindings)
  await update($, prsAtom, prs => prs.filter(pr => bindings.some(one => one.id === pr.id)))
  await rememberSnapshots($, await read($, prsAtom))
}

async function rememberSnapshots($: $, prs: PrSnapshot[]) {
  try {
    await $.store.set(snapshotsKeyOf(await $.session.id()), prs)
  } catch {
    // A cache only: the next read writes it again.
  }
}

async function recallSnapshots($: $): Promise<PrSnapshot[]> {
  try {
    const value = await $.store.get(snapshotsKeyOf(await $.session.id()))

    return Array.isArray(value) ? (value as PrSnapshot[]) : []
  } catch {
    return []
  }
}

/**
 * Starts a refresh on the clock, so it outlives the dispatch that asked for
 * it (a draw, a finished turn); at most one per `minMs`.
 */
async function kick($: $, minMs = 15_000) {
  const state = await stateOf($)
  const now = await $.clock.now()

  if (now - state.lastKickAt < minMs) {
    return
  }

  state.lastKickAt = now

  try {
    $.clock.after(0, () => {
      void refresh($)
    })
  } catch {
    // The poll and the next prompt read again.
  }
}

/** How the Azure CLI starts here: `az`, or on Windows its bundled python in UTF-8 mode. */
async function azPrefixOf($: $): Promise<readonly string[]> {
  if (azPrefix) {
    return azPrefix
  }
  if ((await $.env.get('OS')) !== 'Windows_NT') {
    return (azPrefix = ['az'])
  }

  const programFiles = await $.env.get('ProgramFiles')
  const programFilesX86 = await $.env.get('ProgramFiles(x86)')
  const candidates = [
    config.azPython,
    programFiles && `${programFiles}\\Microsoft SDKs\\Azure\\CLI2\\python.exe`,
    programFilesX86 && `${programFilesX86}\\Microsoft SDKs\\Azure\\CLI2\\python.exe`,
  ].filter((path): path is string => Boolean(path))

  for (const path of candidates) {
    if (await $.fs.exists(path).catch(() => false)) {
      // -X utf8: az otherwise prints names in the console's code page.
      return (azPrefix = [path, '-X', 'utf8', '-IBm', 'azure.cli'])
    }
  }

  return (azPrefix = ['cmd', '/d', '/c', 'az'])
}

async function adoFor($: $): Promise<Ado> {
  return adoOf({
    exec: (argv, init) => $.process.run(argv, init),
    azPrefix: await azPrefixOf($),
    cwd: await $.session.cwd(),
    writeFile: (path, text) => $.fs.write(path, text),
    now: () => $.clock.now(),
  })
}

/**
 * Re-reads the checkout and this chat's PRs. Reads run one after another,
 * each with its caller's own `$`; a caller arriving while two are lined up
 * joins the last.
 */
async function refresh($: $): Promise<void> {
  const state = await stateOf($)

  if (state.waiting > 0) {
    return state.tail
  }

  state.waiting += 1
  const run = state.tail.then(() => {
    state.waiting -= 1

    return refreshOnce($)
  })
  state.tail = run.catch(() => undefined)

  return run
}

/** Reads the branch (for Create PR) and every PR bound to this chat; never looks a PR up by branch. */
async function refreshOnce($: $) {
  try {
    const ado = await adoFor($)
    const branch = await ado.branch()
    const bindings = await storedBindings($)

    await update($, branchAtom, () => branch)
    await update($, bindingsAtom, () => bindings)

    const previous = (await read($, prsAtom)).length > 0 ? await read($, prsAtom) : await recallSnapshots($)
    const failures: string[] = []
    const read_ = await Promise.all(
      bindings.map(async binding => {
        // A merged or abandoned PR no longer changes: it is not read again.
        const settled = previous.find(pr => pr.id === binding.id && pr.status !== 'active')

        if (settled) {
          return settled
        }

        try {
          return await ado.snapshot(binding.orgUrl, binding.id)
        } catch (error) {
          failures.push(`#${binding.id}: ${messageOf(error)}`)

          return previous.find(pr => pr.id === binding.id) ?? null
        }
      }),
    )
    const prs = read_.filter((pr): pr is PrSnapshot => pr !== null)

    await update($, prsAtom, () => prs)
    await update($, errorAtom, () => (failures.length > 0 && failures.length === bindings.length ? failures.join('; ') : null))
    await rememberSnapshots($, prs)

    for (const pr of prs) {
      // One PR's trouble must not stop the others being looked at.
      try {
        await react($, ado, previous.find(one => one.id === pr.id) ?? null, pr)
      } catch (error) {
        $.ui.toast(`PR #${pr.id}: ${messageOf(error)}`)
      }
    }
  } catch (error) {
    await update($, errorAtom, () => messageOf(error)).catch(() => undefined)
  }
}

/** What changed since the last read of one PR: merged or closed, a failed build, new comments. */
async function react($: $, ado: Ado, previous: PrSnapshot | null, pr: PrSnapshot) {
  if (previous?.status === 'active' && pr.status !== 'active') {
    $.ui.toast(`PR #${pr.id} ${pr.status === 'completed' ? 'merged' : 'abandoned'}`)
  }
  if (previous && previous.isAutoComplete !== pr.isAutoComplete) {
    $.ui.status(pr.isAutoComplete ? `PR #${pr.id}: auto-complete on` : undefined)
  }

  // A thread that is resolved is forgotten, so one reopened later is handed over again.
  const open = new Set(pr.comments.map(comment => `thread:${pr.id}:${comment.threadId}`))
  await update($, handledAtom, list => list.filter(key => !key.startsWith(`thread:${pr.id}:`) || open.has(key)))

  if (pr.status !== 'active' || !(await read($, autoFixAtom))) {
    return
  }

  await fixFailures($, ado, pr)
  await addressComments($, pr)
}

/** Hands each failed build validation, once, to Claude. */
async function fixFailures($: $, ado: Ado, pr: PrSnapshot, isForced = false) {
  const handled = await read($, handledAtom)
  const failed = pr.checks.filter(
    check => check.kind === 'ci' && check.state === 'failed' && check.buildId !== null && (isForced || !handled.includes(`build:${check.buildId}`)),
  )
  let count = 0

  for (const check of failed) {
    let failure: Awaited<ReturnType<Ado['buildFailure']>>

    try {
      failure = await ado.buildFailure(pr.orgUrl, pr.project, check.buildId as number)
    } catch (error) {
      // Not marked handled: the next read tries again.
      $.ui.toast(`PR #${pr.id}: could not read build ${check.buildId}: ${messageOf(error)}`)
      continue
    }

    await update($, handledAtom, list => [...list, `build:${check.buildId}`].slice(-200))
    $.ui.toast(`PR #${pr.id}: ${failure.pipeline} failed, asking Claude to fix it`)
    await $.prompt.submit({ text: buildFailurePrompt(pr, failure) })
    count += 1
  }

  return count
}

/** Hands the unresolved threads not yet handed over to Claude, in one prompt. */
async function addressComments($: $, pr: PrSnapshot, isForced = false) {
  const handled = await read($, handledAtom)
  const fresh = pr.comments.filter(comment => isForced || !handled.includes(`thread:${pr.id}:${comment.threadId}`))

  if (fresh.length === 0) {
    return 0
  }

  await update($, handledAtom, list => [...list, ...fresh.map(c => `thread:${pr.id}:${c.threadId}`)].slice(-200))
  $.ui.toast(`PR #${pr.id}: ${fresh.length} comment${fresh.length === 1 ? '' : 's'} to address`)
  await $.prompt.submit({ text: commentsPrompt(pr, fresh) })

  return fresh.length
}


async function withBusy<T>($: $, label: string, work: () => Promise<T>): Promise<T | undefined> {
  await update($, busyAtom, () => label)

  try {
    return await work()
  } catch (error) {
    $.ui.toast(`${label} failed: ${messageOf(error)}`)

    return undefined
  } finally {
    await update($, busyAtom, () => null)
  }
}

async function prById($: $, id: number): Promise<PrSnapshot | undefined> {
  return (await read($, prsAtom)).find(pr => pr.id === id)
}

async function toggleAutoMerge($: $, id: number) {
  const pr = await prById($, id)

  if (!pr || pr.status !== 'active') {
    return
  }

  await withBusy($, pr.isAutoComplete ? 'Cancelling auto-complete' : 'Setting auto-complete', async () => {
    const ado = await adoFor($)
    await ado.setAutoComplete(pr.orgUrl, pr.id, !pr.isAutoComplete, config.mergeStrategy, config.deleteSourceBranch)
  })
  await refresh($)
}

async function toggleAutoFix($: $) {
  const isOn = !(await read($, autoFixAtom))
  await update($, autoFixAtom, () => isOn)

  const active = (await read($, prsAtom)).filter(pr => pr.status === 'active')

  if (isOn && active.length > 0) {
    const ado = await adoFor($)
    await withBusy($, 'Reading failures', async () => {
      for (const pr of active) {
        await fixFailures($, ado, pr)
        await addressComments($, pr)
      }
    })
  }
}

async function createPr($: $, input: CreatePrInput): Promise<PrSnapshot> {
  const ado = await adoFor($)
  const branch = await ado.branch()

  if (!branch) {
    throw new Error('origin is not an Azure Repos remote.')
  }
  if (branch.isDefault) {
    throw new Error(`${branch.branch} is the default branch; create a feature branch first.`)
  }

  const id = await ado.create(branch, input)
  await bind($, { orgUrl: branch.orgUrl, id })
  await refresh($)

  return (await prById($, id)) ?? (await ado.snapshot(branch.orgUrl, id))
}

/**
 * Find PR: binds every PR this chat's history mentions that belongs to the
 * checkout's repository, and says what it found.
 */
async function findPrs($: $): Promise<string> {
  const ado = await adoFor($)
  const branch = (await read($, branchAtom)) ?? (await ado.branch())

  if (!branch) {
    return 'This chat is not in an Azure Repos clone.'
  }

  const candidates = prIdsFromHistory(await $.session.messages())

  if (candidates.length === 0) {
    return 'No pull request is mentioned in this chat. Create one, or bind one with /ado-pr link <id>.'
  }

  const found = (await Promise.all(candidates.map(id => ado.describe(branch.orgUrl, id)))).filter(
    (pr): pr is { id: number; repo: string; project: string } =>
      pr !== null && pr.repo.toLowerCase() === branch.repo.toLowerCase() && pr.project.toLowerCase() === branch.project.toLowerCase(),
  )

  if (found.length === 0) {
    return `This chat mentions ${candidates.map(id => `#${id}`).join(', ')}, but none is a pull request of ${branch.project}/${branch.repo}.`
  }

  for (const pr of found) {
    await bind($, { orgUrl: branch.orgUrl, id: pr.id })
  }
  await refresh($)

  return `Found ${found.map(pr => `#${pr.id}`).join(', ')} in this chat.`
}

async function loadMine($: $) {
  const branch = (await read($, branchAtom)) ?? (await (await adoFor($)).branch())

  if (!branch) {
    return 'This session is not in an Azure Repos clone.'
  }

  const list = await (await adoFor($)).mine(branch.orgUrl, branch.project)
  const rows: MinePr[] = list.map(pr => ({
    id: Number(pr.pullRequestId),
    title: String(pr.title ?? ''),
    repo: String(pr.repository?.name ?? ''),
    status: isPrStatus(pr.status) ? pr.status : 'active',
    isDraft: pr.isDraft === true,
    url: `${pr.repository?.webUrl ?? `${branch.orgUrl}/${branch.project}/_git/${pr.repository?.name}`}/pullrequest/${pr.pullRequestId}`,
  }))
  await update($, mineAtom, () => rows)

  return `${rows.length} pull request${rows.length === 1 ? '' : 's'} in ${branch.project}.`
}

const summaryOf = (pr: PrSnapshot) =>
  `PR #${pr.id} ${phaseOf(pr)} (${pr.sourceBranch} → ${pr.targetBranch}): ${pr.title}\n${pr.url}\nCI ${rollupOf(pr.checks)}, ${pr.comments.length} open comment(s), auto-complete ${pr.isAutoComplete ? 'on' : 'off'}`

export const register: Register = (on, options) => {
  config.pollSeconds = Math.max(0, Number(options.pollSeconds ?? 60))
  config.mergeStrategy = String(options.mergeStrategy ?? 'squash')
  config.deleteSourceBranch = options.deleteSourceBranch === true
  config.azPython = String(options.azPython ?? '').trim()

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: 'ado-pr',
      description: "This chat's Azure DevOps pull requests: status, refresh, create, find, link <id>, unlink [id], mine, fix, comments, show",
      argumentHint: '[status|refresh|create|find|link <id>|unlink [id]|mine|fix|comments|show]',
    })

    await $.tool.register({
      name: 'create_pull_request',
      description:
        'Creates an Azure DevOps pull request from the current branch (which must already be pushed) and adds it to this chat as a bar above the prompt. Use when the person asks for a PR in an Azure Repos clone.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PR title' },
          description: { type: 'string', description: 'PR description, Markdown' },
          targetBranch: { type: 'string', description: "Target branch; omit for the repository's default" },
          draft: { type: 'boolean', description: 'Create as a draft' },
          workItemIds: { type: 'array', items: { type: 'string' }, description: 'Azure Boards work item ids to link' },
        },
        required: ['title'],
      },
    })
    await $.tool.register({
      name: 'pull_request_status',
      description: "This chat's Azure DevOps PRs: status, build validations, reviewers, unresolved comments.",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'build_failure_logs',
      description: "Failed steps, errors and log tail of an Azure Pipelines build; default: the failed build validations of this chat's open PRs.",
      inputSchema: { type: 'object', properties: { buildId: { type: 'number' } } },
    })
    await $.tool.register({
      name: 'reply_to_pr_comment',
      description: "Replies on a review thread of one of this chat's Azure DevOps PRs, and optionally resolves it (status fixed).",
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'number' },
          text: { type: 'string', description: 'Reply, Markdown' },
          resolve: { type: 'boolean', description: 'Mark the thread fixed' },
          pullRequestId: { type: 'number', description: 'The PR the thread is on; omit to find it among this chat’s PRs' },
        },
        required: ['threadId', 'text'],
      },
    })

    // The first read runs off the session's start, which waits for nothing slow.
    $.clock.after(1, () => {
      void refresh($)
    })

    if (config.pollSeconds > 0) {
      const state = await stateOf($)
      state.poll?.cancel()
      state.poll = $.clock.every(config.pollSeconds * 1000, () => {
        void (async () => {
          if (!(await read($, hiddenAtom))) {
            await refresh($)
          }
        })()
      })
    }

    return started
  })

  on('session.end', async ($, e, next) => {
    const state = await stateOf($)
    state.poll?.cancel()
    state.poll = null

    return next(e)
  })

  // Each prompt and each finished turn reads again (throttled), so the bars
  // never depend on one timer or one event having run.
  on('prompt.submit', async ($, e, next) => {
    const submitted = await next(e)
    await kick($)

    return submitted
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await kick($, 5_000)

    return done
  })

  // Claude's own `az repos pr create` binds the PR it made to this chat; a
  // push or a branch switch reads again.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)

    if (/\baz\s+repos\s+pr\s+create\b/.test(e.command) && ran.deny === undefined && ran.isError !== true) {
      const id = createdPrIdOf(ran.text ?? '')
      const branch = (await read($, branchAtom)) ?? (await (await adoFor($)).branch())

      if (id !== null && branch) {
        await bind($, { orgUrl: branch.orgUrl, id })
      }
    }
    if (/\bgit\s+(push|checkout|switch|merge|rebase|pull)\b|\baz\s+repos\s+pr\b/.test(e.command)) {
      await refresh($)
    }

    return ran
  })

  on('tool.call', { tool: 'mcp__ado-pr__create_pull_request' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>

    try {
      const pr = await createPr($, {
        title: String(input.title ?? '').trim(),
        description: input.description ? String(input.description) : undefined,
        targetBranch: input.targetBranch ? String(input.targetBranch) : undefined,
        isDraft: input.draft === true,
        workItems: Array.isArray(input.workItemIds) ? input.workItemIds.map(String) : undefined,
      })

      return { result: `Created PR #${pr.id}: ${pr.url}` }
    } catch (error) {
      return { deny: `Could not create the pull request: ${messageOf(error)}` }
    }
  })

  on('tool.call', { tool: 'mcp__ado-pr__pull_request_status' }, async $ => {
    await refresh($)
    const error = await read($, errorAtom)

    return { result: error ? `Azure DevOps error: ${error}` : statusText(await read($, prsAtom), await read($, branchAtom)) }
  })

  on('tool.call', { tool: 'mcp__ado-pr__build_failure_logs' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const prs = await read($, prsAtom)
    const branch = await read($, branchAtom)

    if (!branch) {
      return { deny: 'This session is not in an Azure Repos clone.' }
    }

    try {
      const ado = await adoFor($)
      const targets = input.buildId
        ? [{ buildId: Number(input.buildId), project: prs.find(pr => pr.checks.some(c => c.buildId === Number(input.buildId)))?.project ?? prs[0]?.project ?? branch.project }]
        : prs
            .filter(pr => pr.status === 'active')
            .flatMap(pr => pr.checks.filter(c => c.state === 'failed' && c.buildId !== null).map(c => ({ buildId: c.buildId as number, project: pr.project })))

      if (targets.length === 0) {
        return { result: "No failed build validation on this chat's open PRs." }
      }

      const failures = await Promise.all(targets.map(target => ado.buildFailure(branch.orgUrl, target.project, target.buildId)))

      return { result: failures.map(failureText).join('\n\n') }
    } catch (error) {
      return { deny: messageOf(error) }
    }
  })

  on('tool.call', { tool: 'mcp__ado-pr__reply_to_pr_comment' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const prs = await read($, prsAtom)
    const threadId = Number(input.threadId)
    const pr = input.pullRequestId
      ? prs.find(one => one.id === Number(input.pullRequestId))
      : (prs.find(one => one.comments.some(comment => comment.threadId === threadId)) ?? prs.filter(one => one.status === 'active').at(-1))

    if (!pr) {
      return { deny: 'No pull request of this chat has that thread.' }
    }

    try {
      const ado = await adoFor($)
      await ado.reply(pr, threadId, String(input.text ?? ''), input.resolve === true)
      void refresh($)

      return { result: `Replied on thread ${threadId} of PR #${pr.id}${input.resolve === true ? ' and resolved it' : ''}.` }
    } catch (error) {
      return { deny: messageOf(error) }
    }
  })

  on('command.run', { command: 'ado-pr' }, async ($, e) => {
    const [verb = 'status', arg] = e.args.trim().split(/\s+/).filter(Boolean)

    switch (verb) {
      case 'status':
      case 'refresh': {
        await update($, hiddenAtom, () => false)
        await refresh($)
        const error = await read($, errorAtom)
        const prs = await read($, prsAtom)
        const branch = await read($, branchAtom)

        if (error) {
          return { text: `Azure DevOps: ${error}` }
        }
        if (!branch) {
          return { text: 'Not an Azure Repos clone: origin is not on dev.azure.com or visualstudio.com.' }
        }

        return {
          text:
            prs.length > 0
              ? prs.map(summaryOf).join('\n\n')
              : `No pull request in this chat yet. Find PR looks for one in its history; /ado-pr create asks Claude to open one for ${branch.branch}.`,
        }
      }
      case 'create': {
        const branch = await read($, branchAtom)

        if (!branch) {
          return { text: 'Not an Azure Repos clone.' }
        }

        await $.prompt.submit({ text: createPrPrompt(branch) })

        return { text: 'Asked Claude to push the branch and open a pull request.' }
      }
      case 'find': {
        return { text: await findPrs($).catch(messageOf) }
      }
      case 'link': {
        const id = Number(arg?.replace(/^#/, ''))
        const branch = (await read($, branchAtom)) ?? (await (await adoFor($)).branch())

        if (!Number.isInteger(id) || id <= 0) {
          return { text: 'Usage: /ado-pr link <pull request id>' }
        }
        if (!branch) {
          return { text: 'Not an Azure Repos clone.' }
        }

        await bind($, { orgUrl: branch.orgUrl, id })
        await refresh($)

        return { text: `Added PR #${id} to this chat.` }
      }
      case 'unlink': {
        const id = arg ? Number(arg.replace(/^#/, '')) : undefined
        await unbind($, id)

        return { text: id ? `Removed PR #${id} from this chat.` : 'Removed every pull request from this chat.' }
      }
      case 'show': {
        await update($, hiddenAtom, () => false)
        await refresh($)

        return { text: 'Showing the pull request bars.' }
      }
      case 'mine': {
        const text = await loadMine($).catch(messageOf)
        await $.ui.open({ id: MINE_PANE, title: 'My Azure DevOps PRs' })

        return { text }
      }
      case 'fix':
      case 'comments': {
        await refresh($)
        const active = (await read($, prsAtom)).filter(pr => pr.status === 'active')

        if (active.length === 0) {
          return { text: 'This chat has no open pull request.' }
        }

        const ado = await adoFor($)
        let count = 0

        for (const pr of active) {
          count += verb === 'fix' ? await fixFailures($, ado, pr, true) : await addressComments($, pr, true)
        }

        return { text: count ? `Handed ${count} item(s) to Claude.` : verb === 'fix' ? 'No failed build validation.' : 'No unresolved comments.' }
      }
      default:
        return { text: 'Usage: /ado-pr [status|refresh|create|find|link <id>|unlink [id]|mine|fix|comments|show]' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) {
      return next(e)
    }

    // A draw is a sign someone is looking: read again when the data is stale.
    await kick($, Math.max(15, config.pollSeconds || 60) * 1000)

    const branch = await read($, branchAtom)
    const live = await read($, prsAtom)
    const prs = live.length > 0 ? live : await recallSnapshots($)

    if (!branch && prs.length === 0) {
      return next(e)
    }

    const error = await read($, errorAtom)
    const busy = await read($, busyAtom)
    const openMenu = await read($, openMenuAtom)
    const autoFix = await read($, autoFixAtom)
    const now = await $.clock.now()
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const isDesktop = e.surface === 'desktop'

    const close = <Button key="ado-close" label="×" plain role="dismiss" onPress={() => update($, hiddenAtom, () => true)} />
    const branchCode = (key: string, name: string) => <Markdown key={key} text={'`' + name + '`'} />

    const icon = (phase: ReturnType<typeof phaseOf>, size: number) => {
      if (e.surface === 'desktop') {
        const { Svg } = $.ui.resolve(e)

        return <Svg source={iconSvg(phase, size)} alt={ICON_ALT[phase]} width={size} height={size} />
      }

      return (
        <Text color={PHASE_COLOR[phase]} bold>
          ⑂
        </Text>
      )
    }

    // A rounded pill of bold monospace runs on the desktop; bold coloured text on the terminal.
    const chip = (key: string, parts: ChipPart[], themed: ('diffAdded' | 'diffRemoved' | 'inactive')[]) => {
      if (e.surface === 'desktop') {
        const { Svg } = $.ui.resolve(e)
        const pill = chipSvg(parts)

        return <Svg key={key} source={pill.source} alt={parts.map(part => part.text).join(' ')} width={pill.width} height={pill.height} />
      }

      return (
        <Box key={key} flexDirection="row" gap={1}>
          {parts.map((part, i) => (
            <Text key={`${key}-${i}`} bold color={themed[i]}>
              {part.text}
            </Text>
          ))}
        </Box>
      )
    }

    const commentIcon = () => {
      if (e.surface === 'desktop') {
        const { Svg } = $.ui.resolve(e)

        return <Svg source={commentSvg(16)} alt="Unresolved comments" width={16} height={16} />
      }

      return <Text color="warning">✎</Text>
    }

    const box = (isOn: boolean) => (isOn ? '☑' : '☐')

    /** One PR: its hover card and CI panel (inside the band, above its row) and its bar row. */
    const prBlock = (pr: PrSnapshot, isLast: boolean, panelBudget: number) => {
      const phase = phaseOf(pr)
      const rollup = rollupOf(pr.checks)
      const isMenuOpen = openMenu === pr.id
      const isAnyMenuOpen = openMenu !== null
      const ciColor = rollup === 'passed' ? 'success' : rollup === 'failed' ? 'error' : rollup === 'running' ? 'warning' : 'inactive'
      const scope = cardScopeOf(pr.id)
      const ci = pr.checks.filter(check => check.kind === 'ci')
      const policies = pr.checks.filter(check => check.kind === 'policy')
      const isActive = pr.status === 'active'
      const isReady =
        isActive && pr.mergeStatus === 'succeeded' && pr.votes.rejected === 0 && pr.votes.waiting === 0 && pr.checks.every(c => !c.isBlocking || c.state === 'passed' || c.state === 'skipped')
      const votes = `${pr.votes.approved} approved, ${pr.votes.waiting} waiting${pr.votes.rejected ? `, ${pr.votes.rejected} rejected` : ''}`

      const lines = (key: string) =>
        pr.additions === null || pr.deletions === null
          ? null
          : chip(
              key,
              [
                { text: `+${thousands(pr.additions)}`, color: CHIP_COLORS.added },
                { text: `−${thousands(pr.deletions)}`, color: CHIP_COLORS.removed },
              ],
              ['diffAdded', 'diffRemoved'],
            )

      const card = (
        <Box
          key={`ado-card-${pr.id}`}
          alignSelf="flex-start"
          width={Math.min(64, Math.max(40, e.props.bodyColumns - 4))}
          marginBottom={1}
          display="none"
          hover={isAnyMenuOpen ? undefined : { scope, display: 'flex' }}
          flexDirection="column"
          gap={1}
          paddingX={2}
          paddingY={1}
          borderStyle="round"
          borderColor="inactive"
        >
          <Box flexDirection="row" gap={2} alignItems="center">
            <Box flexDirection="row" gap={1} paddingX={1} borderStyle="round" borderColor={PHASE_COLOR[phase]}>
              {icon(phase, 14)}
              <Text color={PHASE_COLOR[phase]}>{PHASE_LABEL[phase]}</Text>
            </Box>
            <Text dimColor wrap="truncate">{`${pr.project}/${pr.repo} #${pr.id}`}</Text>
            <Box flexGrow={1} />
            <Text dimColor>{agoOf(pr.createdAt, now)}</Text>
          </Box>
          <Text bold wrap="truncate">
            {pr.title}
          </Text>
          <Box flexDirection="row" gap={2} alignItems="center">
            <Text dimColor wrap="truncate">
              {pr.author}
            </Text>
            <Box flexGrow={1} />
            {lines(`ado-card-lines-${pr.id}`)}
            {pr.files !== null &&
              chip(`ado-card-files-${pr.id}`, [{ text: `${pr.files} file${pr.files === 1 ? '' : 's'}`, color: CHIP_COLORS.muted }], ['inactive'])}
          </Box>
        </Box>
      )

      // The band holds at most `maxRows` rows and scrolls past that, from the top, which would push
      // this bar out of sight. So the panel is laid out in whole rows, counted, and its optional lines
      // (the checks, the policy summary, the ready line) give way to fit `panelBudget`.
      const frameRows = 2 + (isDesktop ? 1 : 0)
      const sectionGap = isDesktop ? 0.5 : 1
      const fixedRows = frameRows + 1 + 1 + (isActive ? 1 : 0) + 2 * sectionGap + 1 + sectionGap
      let rest = Math.floor(panelBudget - fixedRows + 1e-9)
      const ciRows = ci.length === 0 ? 1 : ci.length
      const shownChecks = ci.length <= rest ? ci.length : Math.max(0, rest - 1)
      rest -= Math.min(ciRows, Math.max(0, rest))
      const hiddenChecks = ci.length - shownChecks
      const showPolicies = rest >= 1
      rest -= showPolicies ? 1 : 0
      const showReady = isActive && rest >= 1

      const panel = isMenuOpen ? (
        <Box
          key={`ado-ci-panel-${pr.id}`}
          alignSelf="flex-end"
          width={Math.min(60, Math.max(40, e.props.bodyColumns - 2))}
          marginBottom={sectionGap}
          flexDirection="column"
          paddingX={2}
          paddingY={isDesktop ? 0.5 : 0}
          borderStyle="round"
          borderColor="inactive"
        >
          <Box flexDirection="row" gap={1}>
            <Text dimColor wrap="truncate">{`CI · #${pr.id}`}</Text>
            {tallyOf(ci).map(([state, count]) => (
              <Text key={`tally-${pr.id}-${state}`} color={STATE_COLOR[state]}>{`${STATE_ICON[state]} ${count}`}</Text>
            ))}
            <Box flexGrow={1} />
            {busy && <Text color="warning">{`${busy}…`}</Text>}
            <Link href={pr.url}>↗</Link>
          </Box>
          {ci.length === 0 && ciRows <= Math.max(0, panelBudget - fixedRows) && (
            <Text dimColor wrap="truncate">
              No build validation on this PR.
            </Text>
          )}
          {ci.slice(0, shownChecks).map(check => (
            <Box key={`check-${pr.id}-${check.id}`} flexDirection="row" gap={1} paddingLeft={1}>
              <Text color={STATE_COLOR[check.state]}>{STATE_ICON[check.state]}</Text>
              {check.buildId !== null ? (
                <Text wrap="truncate">
                  <Link href={`${pr.orgUrl}/${pr.project}/_build/results?buildId=${check.buildId}`}>{check.name}</Link>
                </Text>
              ) : (
                <Text wrap="truncate">{check.name}</Text>
              )}
              {!check.isBlocking && <Text dimColor>(optional)</Text>}
            </Box>
          ))}
          {hiddenChecks > 0 && shownChecks < ci.length && Math.max(0, panelBudget - fixedRows) >= 1 && (
            <Text dimColor wrap="truncate">{`  +${hiddenChecks} more`}</Text>
          )}
          {showPolicies && (
            <Text dimColor wrap="truncate">
              {`Policies ${policies.filter(p => p.state === 'passed').length}/${policies.length} · ${votes} · ${pr.comments.length} comment${pr.comments.length === 1 ? '' : 's'}`}
            </Text>
          )}
          <Box flexDirection="column" marginTop={sectionGap}>
            <Button key={`ado-autofix-${pr.id}`} plain label={`${box(autoFix)} Auto-fix CI & address comments`} onPress={() => toggleAutoFix($)} />
            {isActive && (
              <Button
                key={`ado-automerge-${pr.id}`}
                plain
                label={`${box(pr.isAutoComplete)} Auto-merge when ready`}
                onPress={() => toggleAutoMerge($, pr.id)}
              />
            )}
            {showReady && (
              <Text dimColor wrap="truncate">
                {isReady ? '   Ready to merge now.' : `   Completes (${config.mergeStrategy}) once required policies pass.`}
              </Text>
            )}
          </Box>
          <Box flexDirection="row" gap={1} marginTop={sectionGap}>
            <Button key={`ado-refresh-${pr.id}`} label="Refresh" onPress={() => refresh($)} />
            {isActive && rollup === 'failed' && (
              <Button
                key={`ado-fix-${pr.id}`}
                label="Fix CI now"
                onPress={() => withBusy($, 'Reading failures', async () => fixFailures($, await adoFor($), pr, true))}
              />
            )}
            {isActive && pr.comments.length > 0 && (
              <Button key={`ado-comments-${pr.id}`} label="Address comments" onPress={() => addressComments($, pr, true)} />
            )}
            {isActive && pr.isDraft && (
              <Button
                key={`ado-publish-${pr.id}`}
                label="Publish draft"
                onPress={() =>
                  withBusy($, 'Publishing', async () => (await adoFor($)).setDraft(pr.orgUrl, pr.id, false)).then(() => refresh($))
                }
              />
            )}
            <Button key={`ado-unlink-${pr.id}`} label="Remove from chat" onPress={() => unbind($, pr.id)} />
          </Box>
        </Box>
      ) : null

      const row = (
        <Box key={`ado-bar-${pr.id}`} flexDirection="row" gap={2} alignItems="center">
          <Box key={`ado-id-${pr.id}`} flexDirection="row" gap={1} alignItems="center">
            {icon(phase, 16)}
            <Text hover={isAnyMenuOpen ? undefined : { scope, underline: true }} color={PHASE_COLOR[phase]}>
              <Link href={pr.url}>{`#${pr.id}`}</Link>
            </Text>
          </Box>
          <Text dimColor>{pr.repo}</Text>
          <Box flexShrink={1}>{branchCode(`ado-branch-${pr.id}`, pr.sourceBranch)}</Box>
          <Box flexGrow={1} />
          {pr.comments.length > 0 && (
            <Box key={`ado-comment-count-${pr.id}`} flexDirection="row" gap={1} alignItems="center">
              {commentIcon()}
              <Text bold>{String(pr.comments.length)}</Text>
            </Box>
          )}
          <Box key={`ado-ci-${pr.id}`} flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {lines(`ado-lines-${pr.id}`)}
            {rollup !== 'none' && !isDesktop && <Text color={ciColor}>●</Text>}
            <Button
              key={`ado-ci-button-${pr.id}`}
              label={`${isDesktop && rollup !== 'none' ? `${CI_DOT[rollup]} ` : ''}CI ${isMenuOpen ? '▴' : '▾'}`}
              onPress={() => update($, openMenuAtom, open => (open === pr.id ? null : pr.id))}
            />
          </Box>
          {isLast ? close : <Box width={1} />}
        </Box>
      )

      return [card, panel, row]
    }

    // Without an open PR, the chat can create one on its branch; a chat with no PR
    // at all (one from before 0.3.0) can also find the ones its history mentions.
    const hasActive = prs.some(pr => pr.status === 'active')
    const actions =
      branch && !hasActive && !branch.isDefault ? (
        <Box key="ado-actions" flexDirection="row" gap={2} alignItems="center">
          <Text dimColor>{branch.repo}</Text>
          {branchCode('ado-branch-current', branch.branch)}
          <Box flexGrow={1} />
          {busy && <Text color="warning">{`${busy}…`}</Text>}
          {prs.length === 0 && (
            <Button
              key="ado-find"
              label="Find PR"
              onPress={() =>
                withBusy($, 'Looking through this chat', async () => {
                  $.ui.toast(await findPrs($))
                })
              }
            />
          )}
          <Button key="ado-create" label="Create PR" variant="primary" onPress={() => $.prompt.submit({ text: createPrPrompt(branch) })} />
          {close}
        </Box>
      ) : null

    const errorRow =
      error && prs.length === 0 ? (
        <Box key="ado-error" flexDirection="row" gap={2}>
          <Text color="error">⑂ Azure DevOps</Text>
          <Text dimColor wrap="truncate">
            {error}
          </Text>
          <Button key="ado-retry" label="Retry" onPress={() => refresh($)} />
          {actions ? null : close}
        </Box>
      ) : null

    if (prs.length === 0 && !actions && !errorRow) {
      return next(e)
    }

    // Rows breathe on the desktop by a few pixels; the terminal has no unit smaller than a row.
    const gap = (key: string) => (e.surface === 'desktop' ? <Box key={key} height={ROW_GAP} /> : null)

    // The rows left for an open CI panel once every bar, gap and the action row have theirs.
    const gapRows = isDesktop ? ROW_GAP : 0
    const otherRows =
      prs.length + Math.max(0, prs.length - 1) * gapRows + (actions ? 1 + (prs.length > 0 ? gapRows : 0) : 0) + (errorRow ? 1 : 0)
    const panelBudget = e.props.maxRows - otherRows

    // A band clips whatever it draws to itself, so each card and CI panel opens
    // inside it, above its own row: the band grows upward from the prompt.
    return (
      <Box key="ado-band" flexDirection="column">
        {errorRow}
        {prs.flatMap((pr, i) => [i > 0 ? gap(`ado-gap-${pr.id}`) : null, ...prBlock(pr, i === prs.length - 1 && !actions, panelBudget)])}
        {actions && prs.length > 0 ? gap('ado-gap-actions') : null}
        {actions}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: MINE_PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const mine = await read($, mineAtom)
    const bound = (await read($, bindingsAtom)).map(binding => binding.id)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="mine-refresh" label="Refresh" onPress={() => loadMine($)} />
        </Box>
        {mine === null && <Text dimColor>Loading…</Text>}
        {mine?.length === 0 && <Text dimColor>No pull requests.</Text>}
        {(mine ?? []).map(row => {
          const phase = phaseOf(row)

          return (
            <Box key={`mine-${row.id}`} flexDirection="row" gap={1}>
              <Text color={PHASE_COLOR[phase]}>⑂</Text>
              <Link href={row.url}>{`#${row.id}`}</Link>
              <Text dimColor>{row.repo}</Text>
              <Text bold={bound.includes(row.id)} wrap="truncate">
                {row.title}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
