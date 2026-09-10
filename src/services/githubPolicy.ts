export const HISTORICAL_JARVIS_REPOSITORY="artisanguillonrenov-creator/Agent-autonome-socle-";

export function githubAuthSource(env:NodeJS.ProcessEnv=process.env):"GITHUB_FACTORY_TOKEN"|"GITHUB_TOKEN"|"NONE"{
  return env.GITHUB_FACTORY_TOKEN?"GITHUB_FACTORY_TOKEN":env.GITHUB_TOKEN?"GITHUB_TOKEN":"NONE";
}

/** Kept module-private to callers except the two GitHub clients; never log or return it from diagnostics. */
export function resolveGitHubToken(env:NodeJS.ProcessEnv=process.env):string|undefined{
  return env.GITHUB_FACTORY_TOKEN||env.GITHUB_TOKEN||undefined;
}

export function jarvisRepository(env:NodeJS.ProcessEnv=process.env):string{
  return env.JARVIS_REPOSITORY?.trim()||HISTORICAL_JARVIS_REPOSITORY;
}

export function softwareFactoryAllowedRepositories(env:NodeJS.ProcessEnv=process.env):Set<string>{
  const configured=env.SOFTWARE_FACTORY_ALLOWED_REPOS?.split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  return new Set(configured?.length?configured:[HISTORICAL_JARVIS_REPOSITORY.toLowerCase()]);
}

export function assertSoftwareFactoryRepositoryAllowed(owner:string,repo:string,env:NodeJS.ProcessEnv=process.env):void{
  if(!softwareFactoryAllowedRepositories(env).has(`${owner}/${repo}`.toLowerCase()))throw new Error("SOFTWARE_FACTORY_REPOSITORY_NOT_ALLOWED: target repository is not in SOFTWARE_FACTORY_ALLOWED_REPOS");
}
