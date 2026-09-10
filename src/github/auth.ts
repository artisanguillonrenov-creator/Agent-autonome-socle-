/** Shared GitHub authentication authority. Never expose this value in diagnostics. */
export function getGitHubToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITHUB_FACTORY_TOKEN || env.GITHUB_TOKEN || "";
}

