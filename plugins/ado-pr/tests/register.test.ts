import { describe, expect, mock, test } from 'claude-code/testing'

const PR = {
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

const POLICIES = [
  { evaluationId: 'e1', status: 'approved', configuration: { isBlocking: true, type: { displayName: 'Build' }, settings: {} }, context: { buildId: 9 } },
  { evaluationId: 'e2', status: 'notApplicable', configuration: { isBlocking: false, type: { displayName: 'Build' }, settings: { displayName: 'nightly' } } },
]

const PRESENTATION = { isFullscreen: false, columns: 120 }

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

describe('register', () => {
  test('the band shows the branch PR, its lines and CI, and the menu sets auto-complete', async ($, on) => {
    const calls: string[][] = []
    mock.clock(on)
    mock.env(on, {})
    mock.store(on, {})
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('tool.register', ($, e) => ({ value: { tool: `mcp__ado-pr__${e.name}` } }))
    // Answers git and az the way a clone of acme/Shop/web on feature/checkout with PR 42 would.
    on('process.run', ($, e) => {
      const argv = [...e.argv]
      calls.push(argv)
      const line = argv.join(' ')
      const ok = (stdout: unknown) => ({
        value: { exitCode: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      })

      if (line.startsWith('git remote get-url')) return ok('https://acme@dev.azure.com/acme/Shop/_git/web\n')
      if (line.startsWith('git rev-parse --abbrev-ref HEAD')) return ok('feature/checkout\n')
      if (line.startsWith('git rev-parse --abbrev-ref --symbolic-full-name')) return ok('origin/feature/checkout\n')
      if (line.startsWith('git symbolic-ref')) return ok('origin/main\n')
      if (line.startsWith('git cat-file')) return ok('')
      if (line.startsWith('git diff --shortstat')) return ok(' 12 files changed, 1264 insertions(+), 206 deletions(-)\n')
      if (line.includes('repos pr list')) return ok([PR])
      if (line.includes('repos pr show')) return ok(PR)
      if (line.includes('repos pr policy list')) return ok(POLICIES)
      if (line.includes('repos pr update')) return ok({ ...PR, autoCompleteSetBy: { displayName: 'me' } })
      if (line.includes('pullRequestThreads')) return ok({ value: [] })
      if (line.includes('pipelines build show')) return ok({ definition: { name: 'web-ci' } })

      return { value: { exitCode: 1, stdout: '', stderr: `unexpected: ${line}`, isStdoutTruncated: false, isStderrTruncated: false } }
    })


    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const { text } = await $.command.run({ command: 'ado-pr', args: 'refresh', origin: { kind: 'composer' }, presentation: PRESENTATION })

    expect(text).toContain('PR #42 open: Add checkout')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'ado-pr', surface, ...BAND })

      expect(await ui.find({ text: '#42' })).toBeDefined()
      expect(await ui.find({ key: 'ado-card' })).toBeDefined()
      expect(await ui.find({ text: /shop\/web #42|Shop\/web #42/ })).toBeDefined()
      expect(await ui.find({ text: /Ann Author/ })).toBeDefined()
      if (surface === 'desktop') {
        // The chips are SVG pills on the desktop: their text is in the source and the alt.
        const alts = (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt))
        expect(alts).toContain('+1,264 −206')
        expect(alts).toContain('12 files')
        expect(alts).toContain('Open pull request')
        const pill = (await ui.findAll({ type: 'Svg' })).find(svg => svg.props.alt === '+1,264 −206')
        expect(String(pill?.props.source)).toContain('#383838')
        expect(String(pill?.props.source)).toContain('&#x2212;206')
      } else {
        expect(await ui.find({ text: /12 files/ })).toBeDefined()
        expect(await ui.find({ text: '+1,264' })).toBeDefined()
        expect(await ui.find({ text: '−206' })).toBeDefined()
      }

      await ui.press({ key: 'ado-ci-button' })
      expect(await ui.find({ text: /Passed/ })).toBeDefined()
      expect(await ui.find({ text: /web-ci/ })).toBeDefined()
      expect(await ui.find({ text: /ready to merge now/ })).toBeDefined()

      if (surface === 'desktop') {
        await ui.press({ key: 'ado-automerge' })
        const update = calls.find(argv => argv.join(' ').includes('repos pr update'))
        expect(update).toEqual(expect.arrayContaining(['--auto-complete', 'true', '--squash', 'true', '--delete-source-branch', 'true']))
      } else {
        await ui.press({ key: 'ado-ci-button' })
      }

      await ui.unmount()
    }
  })

  test('outside an Azure Repos clone the band draws nothing of its own', async ($, on) => {
    mock.clock(on)
    mock.env(on, {})
    mock.store(on, {})
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('tool.register', ($, e) => ({ value: { tool: `mcp__ado-pr__${e.name}` } }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: 'https://github.com/acme/web.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const { text } = await $.command.run({ command: 'ado-pr', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })

    expect(text).toContain('Not an Azure Repos clone')
  })
})
