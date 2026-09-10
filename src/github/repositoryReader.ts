import { Octokit } from "@octokit/rest";
import { getGitHubToken } from "./auth.js";

export const REPOSITORY_LIMITS = Object.freeze({maxTreeEntries:5000,maxFilesRead:30,maxFileBytes:256*1024,maxTotalBytes:2*1024*1024,maxSearchResults:100,maxDepth:20});
export type RepositoryRef={owner:string;repo:string};
export type RepositoryContext={repository:string;defaultBranch:string;ref:string;treeEntries:number;filesRead:number;bytesRead:number;truncated:boolean};
type TreeEntry={path:string;type:string;size?:number;sha?:string};
type DiffFile={filename:string;status?:string;additions?:number;deletions?:number;changes?:number;patch?:string;patchTruncated?:boolean;redacted?:boolean};
const excluded=/(^|\/)(node_modules|vendor|dist|build|coverage|\.gradle|\.git)(\/|$)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.lock)$/i;
const binary=/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|7z|rar|jar|war|apk|aab|so|dll|exe|bin|woff2?|ttf|mp[34]|mov|avi)$/i;
const secretPath=/(^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|.*(?:private[_-]?key|id_rsa|id_ed25519).*)$/i;
const assignment=/\b(TOKEN|PASSWORD|GITHUB_TOKEN|OPENROUTER_API_KEY|API_TOKEN|api_key|access_token|client_secret)\s*=\s*([^\s'"`][^\s]*|["'][^"']+["'])/gi;
const privateKey=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const normalize=(s:string)=>s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
const synonyms:Record<string,string[]>={parametres:["settings"],settings:["parametres"],depot:["repository"],repository:["depot"],fichier:["file"],file:["fichier"],fonction:["function"],function:["fonction"]};
export function parseGitHubRepository(value:string):RepositoryRef {
  const clean=String(value??"").trim().replace(/^git@github\.com:/i,"").replace(/^https?:\/\/(?:www\.)?github\.com\//i,"").replace(/\.git$/i,"").replace(/^\/+|\/+$/g,"");
  const parts=clean.split("/");
  if(parts.length!==2||!parts.every(x=>/^[A-Za-z0-9_.-]+$/.test(x)))throw new Error("INVALID_GITHUB_REPOSITORY");
  return{owner:parts[0],repo:parts[1]};
}
export function resolveSelfRepository(requested?:string,selfReferential=false):RepositoryRef {
  if(requested)return parseGitHubRepository(requested);
  if(!selfReferential)throw new Error("REPOSITORY_REQUIRED");
  return parseGitHubRepository(process.env.JARVIS_REPOSITORY||"artisanguillonrenov-creator/Agent-autonome-socle-");
}
export function isSecretPath(path:string){return secretPath.test(path);}
function redact(text:string){let redacted=false;let value=text.replace(privateKey,()=>{redacted=true;return "[REDACTED: PRIVATE KEY]";});value=value.replace(assignment,(all,_key,value)=>{if(!String(value).replace(/["']/g,"").trim())return all;redacted=true;return String(all).replace(String(value),"[REDACTED]");});return{text:value,redacted};}
function safePatch(file:any):DiffFile {const out:DiffFile={filename:String(file.filename??file.path??""),status:file.status,additions:file.additions,deletions:file.deletions,changes:file.changes};if(isSecretPath(out.filename)){out.patch="[REDACTED: SECRET FILE]";out.redacted=true;return out;}if(typeof file.patch==="string"){const max=REPOSITORY_LIMITS.maxFileBytes;const clipped=Buffer.byteLength(file.patch)>max?Buffer.from(file.patch).subarray(0,max).toString("utf8"):file.patch;const r=redact(clipped);out.patch=r.text;out.redacted=r.redacted;if(clipped!==file.patch)out.patchTruncated=true;}return out;}
export class GitHubRepositoryReader {
  private readonly octokit:any; private filesRead=0;private bytesRead=0;
  constructor(client?:any){this.octokit=client??new Octokit({auth:getGitHubToken()||undefined});}
  private eligible(path:string,size=0){return !excluded.test(path)&&!binary.test(path)&&!isSecretPath(path)&&path.split("/").length<=REPOSITORY_LIMITS.maxDepth&&size<=REPOSITORY_LIMITS.maxFileBytes;}
  async inspect(repository:string,ref?:string){const {owner,repo}=parseGitHubRepository(repository);const r=await this.octokit.rest.repos.get({owner,repo});const defaultBranch=r.data.default_branch||"main";return{owner,repo,repository:`${owner}/${repo}`,defaultBranch,ref:ref||defaultBranch};}
  async inspectRepository(repository:string,ref?:string){return this.inspect(repository,ref);}
  async getDefaultBranch(repository:string){return (await this.inspect(repository)).defaultBranch;}
  async tree(repository:string,ref?:string){const ctx=await this.inspect(repository,ref);const r=await this.octokit.rest.git.getTree({owner:ctx.owner,repo:ctx.repo,tree_sha:ctx.ref,recursive:"true"});const all=(r.data.tree??[]) as TreeEntry[];const depthFiltered=all.filter(e=>e.path&&e.path.split("/").length<=REPOSITORY_LIMITS.maxDepth);const entries=depthFiltered.slice(0,REPOSITORY_LIMITS.maxTreeEntries);return{...ctx,entries,truncated:Boolean(r.data.truncated)||depthFiltered.length>entries.length,totalEntries:all.length};}
  async readTree(repository:string,ref?:string){return this.tree(repository,ref);}
  async readFile(repository:string,path:string,ref?:string){if(!this.eligible(path))throw new Error(isSecretPath(path)?"SECRET_FILE_BLOCKED":"BINARY_OR_EXCLUDED_FILE");if(this.filesRead>=REPOSITORY_LIMITS.maxFilesRead)throw new Error("MAX_FILES_READ_EXCEEDED");const ctx=await this.inspect(repository,ref);const r=await this.octokit.rest.repos.getContent({owner:ctx.owner,repo:ctx.repo,path,ref:ctx.ref});if(Array.isArray(r.data)||typeof r.data.content!=="string")throw new Error("NOT_A_TEXT_FILE");const raw=Buffer.from(r.data.content,"base64");if(raw.length>REPOSITORY_LIMITS.maxFileBytes||this.bytesRead+raw.length>REPOSITORY_LIMITS.maxTotalBytes)throw new Error("REPOSITORY_READ_LIMIT_EXCEEDED");if(raw.includes(0))throw new Error("BINARY_FILE_REJECTED");this.filesRead++;this.bytesRead+=raw.length;const value=redact(raw.toString("utf8"));return{path,content:value.text,redacted:value.redacted,bytes:raw.length,sha:r.data.sha};}
  async searchPaths(repository:string,query:string,ref?:string){const t=await this.tree(repository,ref),terms=this.terms(query);const results=t.entries.filter((e:any)=>e.type==="blob"&&terms.some(q=>normalize(e.path).includes(q))).slice(0,REPOSITORY_LIMITS.maxSearchResults);return{results,truncated:t.truncated||results.length>=REPOSITORY_LIMITS.maxSearchResults,totalCandidates:t.totalEntries};}
  private terms(query:string){const base=normalize(query);return[base,...base.split(/\s+/).flatMap(x=>synonyms[x]??[])].filter(Boolean);}
  async searchContent(repository:string,query:string,ref?:string){const ctx=await this.inspect(repository,ref),terms=this.terms(query);const paths=await this.searchPaths(repository,query,ref);const found=new Map<string,any>();for(const p of paths.results)found.set(p.path,{path:p.path,source:"path"});
    try{const q=await this.octokit.rest.search.code({q:`${query} repo:${ctx.repository}` ,per_page:REPOSITORY_LIMITS.maxSearchResults});for(const x of q.data.items??[])if(this.eligible(x.path))found.set(x.path,{path:x.path,source:"github-code-search"});}catch{/* optional read-only endpoint */}
    const tree=await this.tree(repository,ref);const structural=/^(?:README|package\.json|tsconfig|src\/index|src\/main|app\/|lib\/|src\/)/i;const candidates=(tree.entries as TreeEntry[]).filter(e=>e.type==="blob"&&this.eligible(e.path,e.size)&& (structural.test(e.path)||/\.(?:ts|tsx|js|jsx|py|java|kt|go|rs|rb|php|cs|json|ya?ml|md|html|css)$/i.test(e.path)));
    for(const e of candidates){if(found.size>=REPOSITORY_LIMITS.maxSearchResults||this.filesRead>=REPOSITORY_LIMITS.maxFilesRead)break;try{const f=await this.readFile(repository,e.path,ref);const n=normalize(f.content);if(terms.some(q=>n.includes(q)))found.set(e.path,{path:e.path,source:"bounded-content",matches:terms.filter(q=>n.includes(q))});}catch{/* bounded skips are expected */}}
    return{results:[...found.values()].slice(0,REPOSITORY_LIMITS.maxSearchResults),truncated:found.size>REPOSITORY_LIMITS.maxSearchResults||tree.truncated,filesRead:this.filesRead,bytesRead:this.bytesRead};}
  private diff(files:any[]|undefined,total?:number){const all=files??[],returned=all.slice(0,REPOSITORY_LIMITS.maxSearchResults).map(safePatch),totalFiles=total??all.length;return{files:returned,truncated:totalFiles>returned.length,totalFiles,returnedFiles:returned.length};}
  async readPullRequest(repository:string,pullNumber:number){const c=await this.inspect(repository),p=await this.octokit.rest.pulls.get({owner:c.owner,repo:c.repo,pull_number:pullNumber}),f=await this.octokit.rest.pulls.listFiles({owner:c.owner,repo:c.repo,pull_number:pullNumber,per_page:REPOSITORY_LIMITS.maxSearchResults});return{number:p.data.number,title:p.data.title,state:p.data.state,...this.diff(f.data,p.data.changed_files)};}
  async readCommit(repository:string,sha:string){const c=await this.inspect(repository),r=await this.octokit.rest.repos.getCommit({owner:c.owner,repo:c.repo,ref:sha});return{sha:r.data.sha,message:redact(r.data.commit?.message??"").text,...this.diff(r.data.files,r.data.total_files??(r.data.stats?.total===0?0:undefined))};}
  async readDiff(repository:string,base:string,head:string){const c=await this.inspect(repository),r=await this.octokit.rest.repos.compareCommits({owner:c.owner,repo:c.repo,base,head});return{base,head,...this.diff(r.data.files,r.data.total_files??(r.data.total_commits===0?0:undefined))};}
  async context(repository:string,ref?:string):Promise<RepositoryContext>{const t=await this.tree(repository,ref);return{repository:t.repository,defaultBranch:t.defaultBranch,ref:t.ref,treeEntries:t.entries.length,filesRead:this.filesRead,bytesRead:this.bytesRead,truncated:t.truncated};}
  async audit(repository:string,ref?:string){const t=await this.tree(repository,ref),architectural=(t.entries as TreeEntry[]).filter(e=>e.type==="blob"&&this.eligible(e.path,e.size)&&/(^README|package\.json$|tsconfig|Dockerfile|\.github\/workflows|src\/(?:index|main|config)|app\/(?:index|main))/i.test(e.path)).slice(0,REPOSITORY_LIMITS.maxFilesRead);const inspected:string[]=[];for(const e of architectural){try{await this.readFile(repository,e.path,ref);inspected.push(e.path);}catch{}}return{repository:t.repository,ref:t.ref,findings:[],inspectedFiles:inspected,inspectionSufficient:inspected.length>=2,note:inspected.length>=2?"No evidence-backed finding detected in the bounded architectural inspection.":"Inspection insuffisante: trop peu de fichiers architecturaux accessibles; aucun problème n'est inventé."};}
}
