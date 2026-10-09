/**
 * Finds the pull requests a chat's own history mentions, for Find PR: the
 * PR URLs it printed, the ids `az repos pr create` and the create tool
 * answered, and "PR #123" in its messages. Ids come back in the order they
 * first appear; the caller checks each against Azure DevOps.
 */

/** The fields of a `SessionMessage` this reads. */
export type HistoryMessage = {
  text: string
  toolUses?: readonly { tool: string; input: Record<string, unknown>; text?: string }[]
  toolResults?: readonly { text: string }[]
}

const MENTIONS = [
  /\/pullrequest\/(\d+)/gi,
  /"pullRequestId"\s*:\s*(\d+)/g,
  /\bCreated PR #(\d+)/g,
  /\b(?:PR|pull request)\s*#(\d{2,})/gi,
]

/** After `az repos pr create`, a `--query` may have renamed the id to `id`. */
const CREATED_ID = /"id"\s*:\s*(\d+)/g

function idsIn(text: string, patterns: readonly RegExp[]): number[] {
  const found: { at: number; id: number }[] = []

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      found.push({ at: match.index ?? 0, id: Number(match[1]) })
    }
  }

  return found.sort((a, b) => a.at - b.at).map(hit => hit.id)
}

export function prIdsFromHistory(messages: readonly HistoryMessage[], limit = 20): number[] {
  const ids: number[] = []
  const add = (list: number[]) => {
    for (const id of list) {
      if (Number.isInteger(id) && id > 0 && !ids.includes(id)) {
        ids.push(id)
      }
    }
  }

  for (const message of messages) {
    add(idsIn(message.text, MENTIONS))

    for (const use of message.toolUses ?? []) {
      const command = typeof use.input.command === 'string' ? use.input.command : ''
      const output = use.text ?? ''

      add(idsIn(output, /\baz\s+repos\s+pr\s+create\b/.test(command) ? [...MENTIONS, CREATED_ID] : MENTIONS))
    }
    for (const result of message.toolResults ?? []) {
      add(idsIn(result.text, MENTIONS))
    }
  }

  return ids.slice(0, limit)
}

/** The PR id in the output of a command Claude ran (`az repos pr create`, `--query` or not). */
export function createdPrIdOf(output: string): number | null {
  // The JSON's own id first: a description printed before it may mention other PRs.
  const [own] = idsIn(output, [/"pullRequestId"\s*:\s*(\d+)/g])
  const [id] = own !== undefined ? [own] : idsIn(output, [...MENTIONS, CREATED_ID])

  return id ?? null
}
