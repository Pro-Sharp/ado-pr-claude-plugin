import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CheckState, MinePr, PrSnapshot, RepoBranch } from '../types'

import { adoOf } from './ado'
import type { Ado, CreatePrInput } from './ado'
import { archivePrompt, buildFailurePrompt, commentsPrompt, createPrPrompt, failureText, statusText } from './prompts'
import { CHIP_COLORS, chipSvg, commentSvg, ICON_ALT, iconSvg, PHASE_LABEL } from './icons'
import type { ChipPart } from './icons'
import { agoOf, isPrStatus, phaseOf, rollupOf, tallyOf, thousands } from './status'

type $ = EngineInterface

const MINE_PANE = 'ado-pr-mine'

const branchAtom = atom({ plugin: 'ado-pr', key: 'branch' } as const, null)
const prAtom = atom({ plugin: 'ado-pr', key: 'pr' } as const, null)
const pinnedAtom = atom({ plugin: 'ado-pr', key: 'pinnedId' } as const, null)
const errorAtom = atom({ plugin: 'ado-pr', key: 'error' } as const, null)
const busyAtom = atom({ plugin: 'ado-pr', key: 'busy' } as const, null)
const menuAtom = atom({ plugin: 'ado-pr', key: 'isMenuOpen' } as const, false)
const hiddenAtom = atom({ plugin: 'ado-pr', key: 'isHidden' } as const, false)
const autoFixAtom = atom({ plugin: 'ado-pr', key: 'autoFix' } as const, false)
const autoArchiveAtom = atom({ plugin: 'ado-pr', key: 'autoArchive' } as const, false)
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

/** The hover group of #id and its card. */
const CARD_SCOPE = 'ado-pr-card'

const messageOf = (error: unknown) => String((error as Error)?.message ?? error)

/** The manifest's userConfig, as register received it. */
const config = { pollSeconds: 60, mergeStrategy: 'squash', deleteSourceBranch: true, azPython: '' }

let azPrefix: readonly string[] | null = null
let tail: Promise<void> = Promise.resolve()
let waiting = 0
let poll: Timer | null = null
let lastKickAt = 0

/** What the last good read found in a folder, kept across sessions so a re-opened chat draws at once. */
type Remembered = { branch: RepoBranch | null; pr: PrSnapshot | null }

const memoryKeyOf = (cwd: string) => `snapshot:${cwd.split('\\').join('/').toLowerCase()}`

async function remember($: $, value: Remembered) {
  try {
    await $.store.set(memoryKeyOf(await $.session.cwd()), value)
  } catch {
    // A cache only: the next read writes it again.
  }
}

async function recall($: $): Promise<Remembered | null> {
  try {
    const value = (await $.store.get(memoryKeyOf(await $.session.cwd()))) as Remembered | undefined

    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Starts a refresh on the clock, so it outlives the dispatch that asked for
 * it (a draw, a finished turn); at most one per `minMs`.
 */
async function kick($: $, minMs = 15_000) {
  const now = await $.clock.now()

  if (now - lastKickAt < minMs) {
    return
  }

  lastKickAt = now

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
 * Re-reads the branch and its PR. Reads run one after another, each with its
 * caller's own `$`; a caller arriving while two are lined up joins the last.
 */
function refresh($: $): Promise<void> {
  if (waiting > 0) {
    return tail
  }

  waiting += 1
  const run = tail.then(() => {
    waiting -= 1

    return refreshOnce($)
  })
  tail = run.catch(() => undefined)

  return run
}

async function refreshOnce($: $) {
  try {
    const ado = await adoFor($)
    const branch = await ado.branch()
    const before = await read($, branchAtom)

    await update($, branchAtom, () => branch)

    if (!branch) {
      await update($, prAtom, () => null)
      await update($, errorAtom, () => null)
      await remember($, { branch: null, pr: null })

      return
    }
    if (before && before.branch !== branch.branch) {
      await update($, pinnedAtom, () => null)
    }

    const pinned = await read($, pinnedAtom)
    const id = pinned ?? (await ado.findPrId(branch))
    const previous = await read($, prAtom)

    if (id === null) {
      await update($, prAtom, () => null)
      await update($, errorAtom, () => null)
      await remember($, { branch, pr: null })

      return
    }

    const pr = await ado.snapshot(branch.orgUrl, id)

    await update($, prAtom, () => pr)
    await update($, errorAtom, () => null)
    await remember($, { branch, pr })
    await react($, ado, previous?.id === pr.id ? previous : null, pr)
  } catch (error) {
    await update($, errorAtom, () => messageOf(error)).catch(() => undefined)
  }
}

/** What changed since the last read: merged or closed, a failed build, new comments. */
async function react($: $, ado: Ado, previous: PrSnapshot | null, pr: PrSnapshot) {
  if (previous?.status === 'active' && pr.status !== 'active') {
    $.ui.toast(`PR #${pr.id} ${pr.status === 'completed' ? 'merged' : 'abandoned'}`)

    if (await read($, autoArchiveAtom)) {
      await archive($, pr)
    }
  }
  if (previous && previous.isAutoComplete !== pr.isAutoComplete) {
    $.ui.status(pr.isAutoComplete ? `PR #${pr.id}: auto-complete on` : undefined)
  }
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

  for (const check of failed) {
    await update($, handledAtom, list => [...list, `build:${check.buildId}`].slice(-200))
    const failure = await ado.buildFailure(pr.orgUrl, pr.project, check.buildId as number)
    $.ui.toast(`PR #${pr.id}: ${failure.pipeline} failed, asking Claude to fix it`)
    await $.prompt.submit({ text: buildFailurePrompt(pr, failure) })
  }

  return failed.length
}

/** Hands the unresolved threads not yet handed over to Claude, in one prompt. */
async function addressComments($: $, pr: PrSnapshot, isForced = false) {
  const handled = await read($, handledAtom)
  const fresh = pr.comments.filter(comment => isForced || !handled.includes(`thread:${comment.threadId}`))

  if (fresh.length === 0) {
    return 0
  }

  await update($, handledAtom, list => [...list, ...fresh.map(c => `thread:${c.threadId}`)].slice(-200))
  $.ui.toast(`PR #${pr.id}: ${fresh.length} comment${fresh.length === 1 ? '' : 's'} to address`)
  await $.prompt.submit({ text: commentsPrompt(pr, fresh) })

  return fresh.length
}

/** The desktop app lends Claude a tool that archives the session; elsewhere there is none. */
async function archive($: $, pr: PrSnapshot) {
  const tools = await $.tool.list().catch(() => [])
  const tool = tools.map(t => t.name).find(name => /archive_session$/.test(name))

  if (tool) {
    await $.prompt.submit({ text: archivePrompt(pr, tool) })
  } else {
    $.ui.toast('This surface has no session archive; archive it from the sidebar.')
  }
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

async function toggleAutoMerge($: $) {
  const pr = await read($, prAtom)

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

  const pr = await read($, prAtom)

  if (isOn && pr?.status === 'active') {
    const ado = await adoFor($)
    await withBusy($, 'Reading failures', async () => {
      await fixFailures($, ado, pr)
      await addressComments($, pr)
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
  await update($, pinnedAtom, () => id)
  await update($, hiddenAtom, () => false)
  await refresh($)

  return (await read($, prAtom)) ?? (await ado.snapshot(branch.orgUrl, id))
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


export const register: Register = (on, options) => {
  config.pollSeconds = Math.max(0, Number(options.pollSeconds ?? 60))
  config.mergeStrategy = String(options.mergeStrategy ?? 'squash')
  config.deleteSourceBranch = options.deleteSourceBranch !== false
  config.azPython = String(options.azPython ?? '').trim()

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: 'ado-pr',
      description: 'Azure DevOps pull request of this branch: status, refresh, create, link <id>, unlink, mine, fix, comments, show',
      argumentHint: '[status|refresh|create|link <id>|unlink|mine|fix|comments|show]',
    })

    await $.tool.register({
      name: 'create_pull_request',
      description:
        'Creates an Azure DevOps pull request from the current branch (which must already be pushed) and shows it above the prompt. Use when the person asks for a PR in an Azure Repos clone.',
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
      description: "The current branch's Azure DevOps PR: status, build validations, reviewers, unresolved comments.",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'build_failure_logs',
      description: "Failed steps, errors and log tail of an Azure Pipelines build; default: the current PR's failed build validations.",
      inputSchema: { type: 'object', properties: { buildId: { type: 'number' } } },
    })
    await $.tool.register({
      name: 'reply_to_pr_comment',
      description: 'Replies on a review thread of the current Azure DevOps PR, and optionally resolves it (status fixed).',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'number' },
          text: { type: 'string', description: 'Reply, Markdown' },
          resolve: { type: 'boolean', description: 'Mark the thread fixed' },
        },
        required: ['threadId', 'text'],
      },
    })

    // The first read runs off the session's start, which waits for nothing slow.
    $.clock.after(1, () => {
      void refresh($)
    })

    if (config.pollSeconds > 0) {
      poll?.cancel()
      poll = $.clock.every(config.pollSeconds * 1000, () => {
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
    poll?.cancel()
    poll = null

    return next(e)
  })

  // Each prompt and each finished turn reads again (throttled), so the bar
  // never depends on one timer or one event having run.
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

  // A push, a branch switch or Claude's own `az repos pr` call: read again.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)

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

    return { result: error ? `Azure DevOps error: ${error}` : statusText(await read($, prAtom), await read($, branchAtom)) }
  })

  on('tool.call', { tool: 'mcp__ado-pr__build_failure_logs' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const pr = await read($, prAtom)
    const branch = await read($, branchAtom)

    if (!branch) {
      return { deny: 'This session is not in an Azure Repos clone.' }
    }

    try {
      const ado = await adoFor($)
      const ids = input.buildId
        ? [Number(input.buildId)]
        : (pr?.checks ?? []).filter(c => c.state === 'failed' && c.buildId !== null).map(c => c.buildId as number)

      if (ids.length === 0) {
        return { result: 'No failed build validation on the current PR.' }
      }

      const failures = await Promise.all(ids.map(id => ado.buildFailure(branch.orgUrl, pr?.project ?? branch.project, id)))

      return { result: failures.map(failureText).join('\n\n') }
    } catch (error) {
      return { deny: messageOf(error) }
    }
  })

  on('tool.call', { tool: 'mcp__ado-pr__reply_to_pr_comment' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const pr = await read($, prAtom)

    if (!pr) {
      return { deny: 'No pull request is bound to this session.' }
    }

    try {
      const ado = await adoFor($)
      await ado.reply(pr, Number(input.threadId), String(input.text ?? ''), input.resolve === true)
      void refresh($)

      return { result: `Replied on thread ${input.threadId}${input.resolve === true ? ' and resolved it' : ''}.` }
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
        const pr = await read($, prAtom)
        const branch = await read($, branchAtom)

        if (error) {
          return { text: `Azure DevOps: ${error}` }
        }
        if (!branch) {
          return { text: 'Not an Azure Repos clone: origin is not on dev.azure.com or visualstudio.com.' }
        }

        return {
          text: pr
            ? `PR #${pr.id} ${phaseOf(pr)}: ${pr.title}\n${pr.url}\nCI ${rollupOf(pr.checks)}, ${pr.comments.length} open comment(s), auto-complete ${pr.isAutoComplete ? 'on' : 'off'}`
            : `No pull request for ${branch.branch} yet. /ado-pr create asks Claude to open one.`,
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
      case 'link': {
        const id = Number(arg?.replace(/^#/, ''))

        if (!Number.isInteger(id) || id <= 0) {
          return { text: 'Usage: /ado-pr link <pull request id>' }
        }

        await update($, pinnedAtom, () => id)
        await update($, hiddenAtom, () => false)
        await refresh($)

        return { text: `Bound PR #${id} to this session.` }
      }
      case 'unlink': {
        await update($, pinnedAtom, () => null)
        await update($, prAtom, () => null)
        await update($, hiddenAtom, () => true)

        return { text: 'Unbound the pull request; /ado-pr show brings the bar back.' }
      }
      case 'show': {
        await update($, hiddenAtom, () => false)
        await refresh($)

        return { text: 'Showing the pull request bar.' }
      }
      case 'mine': {
        const text = await loadMine($).catch(messageOf)
        await $.ui.open({ id: MINE_PANE, title: 'My Azure DevOps PRs' })

        return { text }
      }
      case 'fix':
      case 'comments': {
        await refresh($)
        const pr = await read($, prAtom)

        if (!pr) {
          return { text: 'No pull request is bound to this session.' }
        }

        const count = verb === 'fix' ? await fixFailures($, await adoFor($), pr, true) : await addressComments($, pr, true)

        return { text: count ? `Handed ${count} item(s) to Claude.` : verb === 'fix' ? 'No failed build validation.' : 'No unresolved comments.' }
      }
      default:
        return { text: 'Usage: /ado-pr [status|refresh|create|link <id>|unlink|mine|fix|comments|show]' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) {
      return next(e)
    }

    // A draw is a sign someone is looking: read again when the data is stale.
    await kick($, Math.max(15, config.pollSeconds || 60) * 1000)

    const live = await read($, branchAtom)
    const remembered = live ? null : await recall($)
    const branch = live ?? remembered?.branch ?? null

    if (!branch) {
      return next(e)
    }

    const pr = live ? await read($, prAtom) : (remembered?.pr ?? null)
    const error = await read($, errorAtom)
    const busy = await read($, busyAtom)
    const isDesktop = e.surface === 'desktop'
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)

    const close = <Button key="ado-close" label="×" plain role="dismiss" onPress={() => update($, hiddenAtom, () => true)} />
    const branchCode = <Markdown key="ado-branch" text={'`' + branch.branch + '`'} />

    if (!pr) {
      if (error) {
        return (
          <Box flexDirection="row" gap={2}>
            <Text color="error">⑂ Azure DevOps</Text>
            <Text dimColor wrap="truncate">
              {error}
            </Text>
            <Button key="ado-retry" label="Retry" onPress={() => refresh($)} />
            {close}
          </Box>
        )
      }
      if (branch.isDefault) {
        return next(e)
      }

      return (
        <Box flexDirection="row" gap={2} alignItems="center">
          <Text dimColor>{branch.repo}</Text>
          {branchCode}
          <Box flexGrow={1} />
          <Button key="ado-create" label="Create PR" variant="primary" onPress={() => $.prompt.submit({ text: createPrPrompt(branch) })} />
          {close}
        </Box>
      )
    }

    const phase = phaseOf(pr)
    const rollup = rollupOf(pr.checks)
    const isMenuOpen = await read($, menuAtom)
    const ciColor = rollup === 'passed' ? 'success' : rollup === 'failed' ? 'error' : rollup === 'running' ? 'warning' : 'inactive'
    const now = await $.clock.now()

    const icon = (size: number) => {
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
            <Text bold color={themed[i]}>
              {part.text}
            </Text>
          ))}
        </Box>
      )
    }

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

    const commentIcon = () => {
      if (e.surface === 'desktop') {
        const { Svg } = $.ui.resolve(e)

        return <Svg source={commentSvg(16)} alt="Unresolved comments" width={16} height={16} />
      }

      return <Text color="warning">✎</Text>
    }

    // The card over the bar while #id is hovered, as GitHub's.
    const card = (
      <Box
        key="ado-card"
        alignSelf="flex-start"
        width={Math.min(64, Math.max(40, e.props.bodyColumns - 4))}
        marginBottom={1}
        display="none"
        hover={isMenuOpen ? undefined : { scope: CARD_SCOPE, display: 'flex' }}
        flexDirection="column"
        gap={1}
        paddingX={2}
        paddingY={1}
        borderStyle="round"
        borderColor="inactive"
      >
        <Box flexDirection="row" gap={2} alignItems="center">
          <Box flexDirection="row" gap={1} paddingX={1} borderStyle="round" borderColor={PHASE_COLOR[phase]}>
            {icon(14)}
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
          {lines('ado-card-lines')}
          {pr.files !== null &&
            chip('ado-card-files', [{ text: `${pr.files} file${pr.files === 1 ? '' : 's'}`, color: CHIP_COLORS.muted }], ['inactive'])}
        </Box>
      </Box>
    )

    const autoFix = await read($, autoFixAtom)
    const autoArchive = await read($, autoArchiveAtom)
    const ci = pr.checks.filter(check => check.kind === 'ci')
    const policies = pr.checks.filter(check => check.kind === 'policy')
    const isActive = pr.status === 'active'
    const isReady =
      isActive && pr.mergeStatus === 'succeeded' && pr.checks.every(c => !c.isBlocking || c.state === 'passed' || c.state === 'skipped')
    const box = (isOn: boolean) => (isOn ? '☑' : '☐')
    const votes = `${pr.votes.approved} approved, ${pr.votes.waiting} waiting${pr.votes.rejected ? `, ${pr.votes.rejected} rejected` : ''}`

    // The CI popover: over the bar at its right end, shown on hover, kept open by a click.
    const popover = (
      <Box
        key="ado-ci-popover"
        alignSelf="flex-end"
        width={Math.min(52, Math.max(36, e.props.bodyColumns - 2))}
        marginBottom={1}
        display={isMenuOpen ? 'flex' : 'none'}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        borderStyle="round"
        borderColor="inactive"
      >
        <Box flexDirection="row" gap={1}>
          <Text dimColor>CI monitoring</Text>
          <Box flexGrow={1} />
          {busy && <Text color="warning">{`${busy}…`}</Text>}
          <Link href={pr.url}>↗</Link>
        </Box>
        {ci.length === 0 && <Text dimColor>No build validation on this PR.</Text>}
        {tallyOf(ci).map(([state, count]) => (
          <Box key={`tally-${state}`} flexDirection="row" gap={1}>
            <Text color={STATE_COLOR[state]}>{STATE_ICON[state]}</Text>
            <Text>{STATE_LABEL[state]}</Text>
            <Box flexGrow={1} />
            <Text dimColor>{String(count)}</Text>
          </Box>
        ))}
        {ci.map(check => (
          <Box key={`check-${check.id}`} flexDirection="row" gap={1} paddingLeft={2}>
            <Text color={STATE_COLOR[check.state]}>{STATE_ICON[check.state]}</Text>
            {check.buildId !== null ? (
              <Link href={`${pr.orgUrl}/${pr.project}/_build/results?buildId=${check.buildId}`}>{check.name}</Link>
            ) : (
              <Text>{check.name}</Text>
            )}
            {!check.isBlocking && <Text dimColor>(optional)</Text>}
          </Box>
        ))}
        <Text dimColor>
          {`Policies ${policies.filter(p => p.state === 'passed').length}/${policies.length} · ${votes} · ${pr.comments.length} open comment${pr.comments.length === 1 ? '' : 's'}`}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Button key="ado-autofix" plain label={`${box(autoFix)} Auto-fix CI & address comments`} onPress={() => toggleAutoFix($)} />
          {isActive && (
            <Button
              key="ado-automerge"
              plain
              label={`${box(pr.isAutoComplete)} Auto-merge when ready`}
              onPress={() => toggleAutoMerge($)}
            />
          )}
          {isActive && (
            <Text dimColor>
              {isReady
                ? '   PR is ready to merge now — nothing to wait for.'
                : `   Completes (${config.mergeStrategy}) once every required policy passes.`}
            </Text>
          )}
          <Button
            key="ado-autoarchive"
            plain
            label={`${box(autoArchive)} Auto-archive on merge or close`}
            onPress={() => update($, autoArchiveAtom, isOn => !isOn)}
          />
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button key="ado-refresh" label="Refresh" onPress={() => refresh($)} />
          {isActive && rollup === 'failed' && (
            <Button
              key="ado-fix"
              label="Fix CI now"
              onPress={() => withBusy($, 'Reading failures', async () => fixFailures($, await adoFor($), pr, true))}
            />
          )}
          {isActive && pr.comments.length > 0 && (
            <Button key="ado-comments" label="Address comments" onPress={() => addressComments($, pr, true)} />
          )}
          {isActive && pr.isDraft && (
            <Button
              key="ado-publish"
              label="Publish draft"
              onPress={() =>
                withBusy($, 'Publishing', async () => (await adoFor($)).setDraft(pr.orgUrl, pr.id, false)).then(() => refresh($))
              }
            />
          )}
        </Box>
      </Box>
    )

    // A band clips whatever it draws to itself, so the card and the CI panel
    // open inside it, above the bar row: the band grows upward from the prompt.
    return (
      <Box key="ado-band" flexDirection="column">
        {card}
        {popover}
        <Box key="ado-bar" flexDirection="row" gap={2} alignItems="center">
          <Box key="ado-id" flexDirection="row" gap={1} alignItems="center">
            {icon(16)}
            <Text hover={isMenuOpen ? undefined : { scope: CARD_SCOPE, underline: true }} color={PHASE_COLOR[phase]}>
              <Link href={pr.url}>{`#${pr.id}`}</Link>
            </Text>
          </Box>
          <Text dimColor>{pr.repo}</Text>
          <Box flexShrink={1}>{branchCode}</Box>
          <Box flexGrow={1} />
          {pr.comments.length > 0 && (
            <Box key="ado-comment-count" flexDirection="row" gap={1} alignItems="center">
              {commentIcon()}
              <Text bold>{String(pr.comments.length)}</Text>
            </Box>
          )}
          <Box key="ado-ci" flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {lines('ado-lines')}
            {rollup !== 'none' && <Text color={ciColor}>●</Text>}
            <Button
              key="ado-ci-button"
              label={isMenuOpen ? 'CI ▴' : 'CI ▾'}
              onPress={() => update($, menuAtom, isOpen => !isOpen)}
            />
          </Box>
          {close}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: MINE_PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const mine = await read($, mineAtom)
    const current = await read($, prAtom)

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
              <Text bold={current?.id === row.id} wrap="truncate">
                {row.title}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}

