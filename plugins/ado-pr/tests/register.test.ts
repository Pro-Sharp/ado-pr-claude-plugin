import { describe, expect, mock, test } from 'claude-code/testing'

const PR_42 = {
  pullRequestId: 42,
  title: 'Add checkout',
  status: 'active',
  isDraft: false,
  mergeStatus: 'succeeded',
  sourceRefName: 'refs/heads/feature/checkout',
  targetRefName: 'refs/heads/main',
  autoCompleteSetBy: null,
  lastMergeSourceCommit: { commitId: 'aaa' },
  lastMergeTargetCommit: { commitId: 'bbb' },
  reviewers: [{ vote: 10, isRequired: true }],
  createdBy: { displayName: 'Ann Author' },
  creationDate: '2026-09-01T10:00:00Z',
  repository: { id: 'r1', name: 'web', webUrl: 'https://dev.azure.com/acme/Shop/_git/web', project: { name: 'Shop' } },
}

/** A second PR of the same chat, abandoned, on another branch. */
const PR_43 = { ...PR_42, pullRequestId: 43, title: 'Old attempt', status: 'abandoned', sourceRefName: 'refs/heads/feature/old' }

/** A PR of another repository, which Find PR must leave out. */
const PR_77 = { ...PR_42, pullRequestId: 77, repository: { ...PR_42.repository, name: 'api' } }

const PRS: Record<string, unknown> = { '42': PR_42, '43': PR_43, '77': PR_77 }

const POLICIES = [
  { evaluationId: 'e1', status: 'approved', configuration: { isBlocking: true, type: { displayName: 'Build' }, settings: {} }, context: { buildId: 9 } },
  { evaluationId: 'e2', status: 'notApplicable', configuration: { isBlocking: false, type: { displayName: 'Build' }, settings: { displayName: 'nightly' } } },
]

const PRESENTATION = { isFullscreen: false, columns: 120 }
const COMPOSER = { kind: 'composer' } as const

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 40,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 39 },
    view: {},
  },
} as const

const ok = (stdout: unknown) => ({
  value: { exitCode: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** git and az as a clone of acme/Shop/web on feature/checkout answers them, PRs 42, 43 and 77 on the server. */
function answer(argv: readonly string[]) {
  const line = argv.join(' ')
  const id = argv[argv.indexOf('--id') + 1] ?? ''

  if (line.startsWith('git remote get-url')) return ok('https://acme@dev.azure.com/acme/Shop/_git/web\n')
  if (line.startsWith('git rev-parse --abbrev-ref HEAD')) return ok('feature/checkout\n')
  if (line.startsWith('git rev-parse --abbrev-ref --symbolic-full-name')) return ok('origin/feature/checkout\n')
  if (line.startsWith('git symbolic-ref')) return ok('origin/main\n')
  if (line.startsWith('git cat-file')) return ok('')
  if (line.startsWith('git diff --shortstat')) return ok(' 12 files changed, 1264 insertions(+), 206 deletions(-)\n')
  if (line.includes('repos pr show') && PRS[id]) return ok(PRS[id])
  if (line.includes('repos pr policy list')) return ok(POLICIES)
  if (line.includes('repos pr update')) return ok({ ...PR_42, autoCompleteSetBy: { displayName: 'me' } })
  if (line.includes('pullRequestThreads')) return ok({ value: [] })
  if (line.includes('pipelines build show')) return ok({ definition: { name: 'web-ci' } })

  return { value: { exitCode: 1, stdout: '', stderr: `ERROR: unexpected ${line}`, isStdoutTruncated: false, isStderrTruncated: false } }
}

describe('register', () => {
  test('a bound PR shows its bar, card and CI panel, whatever branch the checkout is on', async ($, on) => {
    const calls: string[][] = []
    mock.clock(on)
    mock.env(on, {})
    mock.store(on, {})
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work' }))
    on('session.id', () => ({ value: 'chat-1' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('tool.register', ($, e) => ({ value: { tool: `mcp__ado-pr__${e.name}` } }))
    on('process.run', ($, e) => {
      calls.push([...e.argv])

      return answer(e.argv)
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect((await $.command.run({ command: 'ado-pr', args: 'link 42', origin: COMPOSER, presentation: PRESENTATION })).text).toContain('#42')
    const { text } = await $.command.run({ command: 'ado-pr', args: 'status', origin: COMPOSER, presentation: PRESENTATION })

    expect(text).toContain('PR #42 open (feature/checkout → main): Add checkout')
    // A chat never looks its PR up by the checkout's branch.
    expect(calls.some(argv => argv.join(' ').includes('repos pr list'))).toBe(false)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'ado-pr', surface, ...BAND })

      expect(await ui.find({ text: '#42' })).toBeDefined()
      expect(await ui.find({ key: 'ado-card-42' })).toBeDefined()
      expect(await ui.find({ text: /Shop\/web #42/ })).toBeDefined()
      expect(await ui.find({ text: /Ann Author/ })).toBeDefined()
      // An open PR leaves no Find PR / Create PR row.
      expect(await ui.find({ key: 'ado-find' })).toBeUndefined()

      if (surface === 'desktop') {
        const svgs = await ui.findAll({ type: 'Svg' })
        const alts = svgs.map(svg => String(svg.props.alt))
        expect(alts).toContain('+1,264 −206')
        expect(alts).toContain('12 files')
        expect(alts).toContain('Open pull request')
        expect(String(svgs.find(svg => svg.props.alt === '+1,264 −206')?.props.source)).toContain('#383838')
      } else {
        expect(await ui.find({ text: '+1,264' })).toBeDefined()
        expect(await ui.find({ text: '−206' })).toBeDefined()
      }

      await ui.press({ key: 'ado-ci-button-42' })
      expect(await ui.find({ text: /Passed/ })).toBeDefined()
      expect(await ui.find({ text: /web-ci/ })).toBeDefined()
      expect(await ui.find({ text: /ready to merge now/ })).toBeDefined()

      if (surface === 'desktop') {
        await ui.press({ key: 'ado-automerge-42' })
        const update = calls.find(argv => argv.join(' ').includes('repos pr update'))
        expect(update).toEqual(expect.arrayContaining(['--auto-complete', 'true', '--squash', 'true', '--delete-source-branch', 'true']))
      } else {
        await ui.press({ key: 'ado-ci-button-42' })
      }

      await ui.unmount()
    }
  })

  test('a chat with no PR offers Find PR and Create PR, and never borrows the branch PR', async ($, on) => {
    const calls: string[][] = []
    mock.clock(on)
    mock.env(on, {})
    // Another chat of the same folder has PR 42; this one must not show it.
    mock.store(on, { 'bindings:chat-1': [{ orgUrl: 'https://dev.azure.com/acme', id: 42 }] })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work' }))
    on('session.id', () => ({ value: 'chat-2' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('tool.register', ($, e) => ({ value: { tool: `mcp__ado-pr__${e.name}` } }))
    on('process.run', ($, e) => {
      calls.push([...e.argv])

      return answer(e.argv)
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const { text } = await $.command.run({ command: 'ado-pr', args: 'refresh', origin: COMPOSER, presentation: PRESENTATION })

    expect(text).toContain('No pull request in this chat yet')
    expect(calls.some(argv => argv.join(' ').includes('repos pr'))).toBe(false)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'ado-pr', surface, ...BAND })

      expect(await ui.find({ key: 'ado-find' })).toBeDefined()
      expect(await ui.find({ key: 'ado-create' })).toBeDefined()
      expect(await ui.find({ text: '#42' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('Find PR binds every PR of this repository the chat history mentions, one bar each', async ($, on) => {
    mock.clock(on)
    mock.env(on, {})
    mock.store(on, {})
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work' }))
    on('session.id', () => ({ value: 'chat-3' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('tool.register', ($, e) => ({ value: { tool: `mcp__ado-pr__${e.name}` } }))
    on('process.run', ($, e) => answer(e.argv))
    on('session.messages', () => ({
      value: [
        {
          role: 'assistant',
          text: 'Opened https://dev.azure.com/acme/Shop/_git/web/pullrequest/43, and the api change is PR #77.',
          toolUses: [],
        },
        {
          role: 'assistant',
          text: 'Creating the new PR.',
          toolUses: [
            {
              tool_use_id: 't1',
              tool: 'Bash',
              input: { command: 'az repos pr create --title x --query "{id:pullRequestId}"' },
              text: '{\n  "id": 42\n}',
            },
          ],
        },
      ],
    }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const found = await $.command.run({ command: 'ado-pr', args: 'find', origin: COMPOSER, presentation: PRESENTATION })

    expect(found.text).toBe('Found #43, #42 in this chat.')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'ado-pr', surface, ...BAND })

      // Two bars, each on its own branch; the api PR is left out.
      expect(await ui.find({ key: 'ado-bar-43' })).toBeDefined()
      expect(await ui.find({ key: 'ado-bar-42' })).toBeDefined()
      expect(await ui.find({ key: 'ado-bar-77' })).toBeUndefined()
      expect(await ui.find({ text: /feature\/old/ })).toBeDefined()
      expect(await ui.find({ text: /feature\/checkout/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('outside an Azure Repos clone the band draws nothing of its own', async ($, on) => {
    mock.clock(on)
    mock.env(on, {})
    mock.store(on, {})
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work' }))
    on('session.id', () => ({ value: 'chat-4' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('tool.register', ($, e) => ({ value: { tool: `mcp__ado-pr__${e.name}` } }))
    on('process.run', () => ok('https://github.com/acme/web.git\n'))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const { text } = await $.command.run({ command: 'ado-pr', args: '', origin: COMPOSER, presentation: PRESENTATION })

    expect(text).toContain('Not an Azure Repos clone')
  })
})
