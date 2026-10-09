/**
 * Where an Azure Repos remote points: organization URL, project, repository.
 */
export type AdoRemote = {
  /** `https://dev.azure.com/<org>`, the form every `az devops` command takes. */
  orgUrl: string
  org: string
  project: string
  repo: string
}

const decode = (part: string) => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/**
 * Parses the URL forms Azure Repos hands out; anything else is `null`.
 *
 * - https://dev.azure.com/{org}/{project}/_git/{repo}
 * - https://{user}@dev.azure.com/{org}/{project}/_git/{repo}
 * - https://{org}.visualstudio.com[/DefaultCollection]/{project}/_git/{repo}
 * - git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 * - {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 *
 * A repository named like its project may drop the project segment
 * (`.../{org}/_git/{repo}`); the project is then the repository's name.
 */
export function parseAdoRemote(url: string | null | undefined): AdoRemote | null {
  if (!url) {
    return null
  }

  const text = url.trim().replace(/\.git$/, '')

  const patterns = [
    /^(?:[^@]+@)?(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+)$/i,
    /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/(?:([^/]+)\/)?_git\/([^/?#]+)/i,
    /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?(?:([^/]+)\/)?_git\/([^/?#]+)/i,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)
    const [org, project, repo] = [match?.[1], match?.[2], match?.[3]].map(part => (part === undefined ? undefined : decode(part)))

    if (org && repo) {
      return { orgUrl: `https://dev.azure.com/${org}`, org, project: project ?? repo, repo }
    }
  }

  return null
}

/** `refs/heads/feature/x` → `feature/x`. */
export const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, '')

/** `feature/x` → `refs/heads/feature/x`. */
export const fullRef = (branch: string) => (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`)
