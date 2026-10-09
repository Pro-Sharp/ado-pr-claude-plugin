import { describe, expect, test } from 'claude-code/testing'

import { adoOf, azErrorOf } from '../hooks/ado'
import { createdPrIdOf, prIdsFromHistory } from '../hooks/history'
import { parseAdoRemote } from '../hooks/remote'
import { checksOf, commentsOf, parseShortstat, phaseOf, rollupOf, thousands } from '../hooks/status'

describe('parseAdoRemote', () => {
  test('reads every Azure Repos URL form', async () => {
    const want = { orgUrl: 'https://dev.azure.com/acme', org: 'acme', project: 'Shop', repo: 'web' }

    expect(parseAdoRemote('https://dev.azure.com/acme/Shop/_git/web')).toEqual(want)
    expect(parseAdoRemote('https://someone@dev.azure.com/acme/Shop/_git/web')).toEqual(want)
    expect(parseAdoRemote('https://acme.visualstudio.com/Shop/_git/web')).toEqual(want)
    expect(parseAdoRemote('https://acme.visualstudio.com/DefaultCollection/Shop/_git/web')).toEqual(want)
    expect(parseAdoRemote('git@ssh.dev.azure.com:v3/acme/Shop/web')).toEqual(want)
    expect(parseAdoRemote('acme@vs-ssh.visualstudio.com:v3/acme/Shop/web')).toEqual(want)
    expect(parseAdoRemote('https://dev.azure.com/acme/My%20Project/_git/web')?.project).toBe('My Project')
  })

  test('a repository named like its project may drop the project', async () => {
    expect(parseAdoRemote('https://acme.visualstudio.com/_git/Shop')?.project).toBe('Shop')
  })

  test('anything else is not Azure Repos', async () => {
    expect(parseAdoRemote('https://github.com/acme/web.git')).toBe(null)
    expect(parseAdoRemote('')).toBe(null)
  })
})

describe('status', () => {
  test('build and status policies are CI; the worst state wins', async () => {
    const checks = checksOf([
      { evaluationId: 'a', status: 'approved', configuration: { isBlocking: true, type: { displayName: 'Build' }, settings: {} }, context: { buildId: 7 } },
      { evaluationId: 'b', status: 'rejected', configuration: { isBlocking: true, type: { displayName: 'Status' }, settings: { statusGenre: 'sonar', statusName: 'gate' } } },
      { evaluationId: 'c', status: 'queued', configuration: { isBlocking: true, type: { displayName: 'Minimum number of reviewers' }, settings: {} } },
    ])

    expect(checks.map(c => [c.name, c.kind, c.state])).toEqual([
      ['Build', 'ci', 'passed'],
      ['sonar/gate', 'ci', 'failed'],
      ['Minimum number of reviewers', 'policy', 'queued'],
    ])
    expect(checks[0]?.buildId).toBe(7)
    expect(rollupOf(checks)).toBe('failed')
    expect(rollupOf(checks.slice(0, 1))).toBe('passed')
    expect(rollupOf([])).toBe('none')
  })

  test('only active human threads are comments', async () => {
    const comments = commentsOf([
      { id: 1, status: 'active', comments: [{ commentType: 'text', author: { displayName: 'Ann' }, content: 'Rename this' }], threadContext: { filePath: '/a.ts', rightFileStart: { line: 4 } } },
      { id: 2, status: 'fixed', comments: [{ commentType: 'text', content: 'done' }] },
      { id: 3, status: null, properties: { CodeReviewThreadType: { $value: 'VoteUpdate' } }, comments: [{ commentType: 'system' }] },
    ])

    expect(comments).toEqual([{ threadId: 1, author: 'Ann', text: 'Rename this', file: '/a.ts', line: 4 }])
  })

  test('shortstat, phases and numbers', async () => {
    expect(parseShortstat(' 3 files changed, 1264 insertions(+), 206 deletions(-)')).toEqual({ files: 3, additions: 1264, deletions: 206 })
    expect(parseShortstat(' 1 file changed, 1 deletion(-)')).toEqual({ files: 1, additions: 0, deletions: 1 })
    expect(phaseOf({ status: 'completed', isDraft: false })).toBe('merged')
    expect(phaseOf({ status: 'abandoned', isDraft: false })).toBe('closed')
    expect(phaseOf({ status: 'active', isDraft: true })).toBe('draft')
    expect(thousands(1264)).toBe('1,264')
  })

  test('az errors read as what to do', async () => {
    expect(azErrorOf("ERROR: Please run 'az login' to setup account.")).toContain('az login')
    expect(azErrorOf('WARNING: x\nERROR: TF401019: repo not found')).toBe('TF401019: repo not found')
  })
})

describe('history', () => {
  test('finds PR ids in URLs, tool output and prose, in order, once each', async () => {
    const ids = prIdsFromHistory([
      { text: 'See https://dev.azure.com/acme/Shop/_git/web/pullrequest/233 and PR #244.', toolUses: [] },
      {
        text: '',
        toolUses: [
          { tool: 'mcp__ado-pr__create_pull_request', input: { title: 'x' }, text: 'Created PR #251: https://x/pullrequest/251' },
          { tool: 'Bash', input: { command: 'az repos pr create --query "{id:pullRequestId}"' }, text: '{ "id": 260 }' },
          { tool: 'Bash', input: { command: 'az boards query' }, text: '{ "id": 999 }' },
        ],
      },
      { text: 'Back to pull request #233.', toolResults: [{ text: '"pullRequestId": 270' }] },
    ])

    expect(ids).toEqual([233, 244, 251, 260, 270])
  })

  test('reads the id az repos pr create printed', async () => {
    expect(createdPrIdOf('{\n  "pullRequestId": 11,\n  "status": "active"\n}')).toBe(11)
    expect(createdPrIdOf('{ "id": 12, "status": "active" }')).toBe(12)
    expect(createdPrIdOf('nothing here')).toBe(null)
  })

  test("the PR's own id wins over ones its description mentions", async () => {
    expect(createdPrIdOf('{ "description": "follows PR #45, see /pullrequest/46", "pullRequestId": 50 }')).toBe(50)
  })
})

describe('ado', () => {
  const ran: string[][] = []
  const host = (fail?: string) => ({
    exec: async (argv: readonly string[]) => {
      ran.push([...argv])
      if (argv[0] === 'git') return { exitCode: 0, stdout: argv.includes('--absolute-git-dir') ? '/repo/.git' : '', stderr: '' }
      if (fail) return { exitCode: 1, stdout: '', stderr: fail }
      return { exitCode: 0, stdout: argv.includes('account') ? '{"user":{"name":"app-id","type":"servicePrincipal"}}' : '[]', stderr: '' }
    },
    azPrefix: ['az'] as const,
    cwd: '/repo',
    writeFile: async (path: string) => void written.push(path),
    now: async () => 0,
  })
  const written: string[] = []

  test('scratch files are unique per call', async () => {
    const ado = adoOf(host())
    const branch = { orgUrl: 'https://dev.azure.com/o', project: 'p', repo: 'r', branch: 'f', hasUpstream: true, isDefault: false }
    await ado.az(['x']).catch(() => undefined)
    await ado.create(branch, { title: 'a' }).catch(() => undefined)
    await ado.create(branch, { title: 'a' }).catch(() => undefined)
    expect(new Set(written).size).toBe(written.length)
    expect(written.length).toBe(2)
  })

  test('mine skips --creator for a service principal', async () => {
    ran.length = 0
    await adoOf(host()).mine('https://dev.azure.com/o', 'p')
    expect(ran.some(argv => argv.includes('--creator'))).toBe(false)
  })

  test('describe answers null only for a missing PR, not for a sign-in problem', async () => {
    expect(await adoOf(host('ERROR: TF401180: The requested pull request was not found.')).describe('https://dev.azure.com/o', 1)).toBe(null)
    await expect(adoOf(host("ERROR: Please run 'az login' to setup account.")).describe('https://dev.azure.com/o', 1)).rejects.toThrow('az login')
  })
})
