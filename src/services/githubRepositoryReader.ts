import { Octokit } from "@octokit/rest";

export type RepositoryErrorCode =
  | "REPOSITORY_INVALID" | "REPOSITORY_ACCESS_DENIED" | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_REF_NOT_FOUND" | "REPOSITORY_TREE_LIMIT_EXCEEDED"
  | "REPOSITORY_FILE_TOO_LARGE" | "REPOSITORY_BINARY_UNSUPPORTED"
  | "REPOSITORY_SECRET_FILE_BLOCKED" | "REPOSITORY_SEARCH_NO_RESULT";

export class RepositoryInspectionError extends Error {
  constructor(public readonly code:RepositoryErrorCode,message:string=code){super(`${code}: ${message}`);this.name="RepositoryInspectionError";}
}
export interface RepositoryTarget {owner:string;repo:string;ref?:string}
export interface RepositoryLimits {maxTreeEntries:number;maxFilesRead:number;maxFileBytes:number;maxTotalBytes:number;maxSearchResults:number;maxDepth:number}
export const DEFAULT_REPOSITORY_LIMITS:RepositoryLimits={maxTreeEntries:5000,maxFilesRead:30,maxFileBytes:256*1024,maxTotalBytes:2*1024*1024,maxSearchResults:100,maxDepth:20};
export interface RepositoryTreeEntry {path:string;type:"blob"|"tree";size?:number;sha?:string}
export interface RepositoryFile {path:string;content:string;size:number;contentBytes:number;returnedBytes:number;truncated:boolean}
export interface RepositoryContext {repository:string;defaultBranch:string;requestedRef:string;topLevelEntries:string[];importantFiles:string[];languageHints:string[];frameworkHints:string[];packageManager?:string;entryPoints:string[];testCommands:string[];buildCommands:string[]}

const ignored=new Set(["node_modules","vendor","dist","build","coverage",".gradle",".git"]);
const textExtensions=new Set([".ts",".tsx",".js",".jsx",".json",".md",".txt",".yml",".yaml",".toml",".xml",".html",".css",".scss",".sql",".py",".java",".kt",".gradle",".properties"]);
const secretName=/(^|\/)(\.env($|\.)|.*(?:secret|credential|private[-_.]?key).*)/i;
const secretContent=/(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,})/i;
const binaryExtensions=/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|rar|apk|jar|class|so|dll|exe|woff2?|ttf)$/i;
const lockfile=/(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.lock)$/i;

export function parseGitHubRepository(value:string|RepositoryTarget):RepositoryTarget {
  if(typeof value!=="string"){
    if(validPart(value.owner)&&validPart(value.repo))return{owner:value.owner,repo:value.repo.replace(/\.git$/,""),ref:value.ref};
    throw new RepositoryInspectionError("REPOSITORY_INVALID");
  }
  const clean=value.trim().replace(/\.git$/i,"").replace(/\/$/,"");
  const match=clean.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i)??clean.match(/^([^/:\s]+)\/([^/\s]+)$/);
  if(!match||!validPart(match[1])||!validPart(match[2]))throw new RepositoryInspectionError("REPOSITORY_INVALID");
  return{owner:match[1],repo:match[2]};
}
const validPart=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_.-]+$/.test(v)&&v!=="."&&v!=="..";
const depth=(path:string)=>path.split("/").length-1;
const ext=(path:string)=>{const i=path.lastIndexOf(".");return i<0?"":path.slice(i).toLowerCase();};

/** A deliberately read-only GitHub facade. It exposes no mutation primitive. */
export class GitHubRepositoryReader {
  private readonly octokit:any; readonly limits:RepositoryLimits;
  constructor(options:{token?:string;octokitClient?:unknown;limits?:Partial<RepositoryLimits>}={}){this.octokit=options.octokitClient??new Octokit({auth:options.token});this.limits={...DEFAULT_REPOSITORY_LIMITS,...options.limits};}
  async getRepository(target:RepositoryTarget){try{const r=await this.octokit.rest.repos.get({owner:target.owner,repo:target.repo});return{owner:target.owner,repo:target.repo,defaultBranch:r.data.default_branch as string};}catch(e){this.translate(e);}}
  async listTree(target:RepositoryTarget):Promise<{ref:string;entries:RepositoryTreeEntry[];truncated:boolean}>{
    const repository=await this.getRepository(target),ref=target.ref??repository.defaultBranch;
    try{const r=await this.octokit.rest.git.getTree({owner:target.owner,repo:target.repo,tree_sha:ref,recursive:"true"});const raw=(r.data.tree??[]) as any[];
      if(r.data.truncated||raw.length>this.limits.maxTreeEntries)throw new RepositoryInspectionError("REPOSITORY_TREE_LIMIT_EXCEEDED");
      const entries=raw.filter(x=>x.path&&(x.type==="blob"||x.type==="tree")&&depth(x.path)<=this.limits.maxDepth&&!x.path.split("/").some((p:string)=>ignored.has(p))).map(x=>({path:x.path,type:x.type,size:x.size,sha:x.sha}));
      return{ref,entries,truncated:false};
    }catch(e){this.translate(e,"REPOSITORY_REF_NOT_FOUND");}
  }
  async readFile(target:RepositoryTarget,path:string,allowLockfile=false):Promise<RepositoryFile>{
    this.assertReadablePath(path,allowLockfile);
    try{const r=await this.octokit.rest.repos.getContent({owner:target.owner,repo:target.repo,path,ref:target.ref});const data=r.data as any;
      if(Array.isArray(data)||data.type!=="file"||typeof data.content!=="string")throw new RepositoryInspectionError("REPOSITORY_BINARY_UNSUPPORTED");
      const size=Number(data.size??0);if(size>this.limits.maxFileBytes)throw new RepositoryInspectionError("REPOSITORY_FILE_TOO_LARGE");
      const buffer=Buffer.from(data.content.replace(/\n/g,""),data.encoding==="base64"?"base64":"utf8");if(buffer.includes(0))throw new RepositoryInspectionError("REPOSITORY_BINARY_UNSUPPORTED");
      const content=buffer.toString("utf8");if(secretContent.test(content))throw new RepositoryInspectionError("REPOSITORY_SECRET_FILE_BLOCKED");
      return{path,content,size:size||buffer.length,contentBytes:buffer.length,returnedBytes:buffer.length,truncated:false};
    }catch(e){this.translate(e);}
  }
  async readFiles(target:RepositoryTarget,paths:string[]):Promise<RepositoryFile[]>{let total=0;const out:RepositoryFile[]=[];for(const path of paths.slice(0,this.limits.maxFilesRead)){const file=await this.readFile(target,path);total+=file.returnedBytes;if(total>this.limits.maxTotalBytes)throw new RepositoryInspectionError("REPOSITORY_FILE_TOO_LARGE","total byte limit exceeded");out.push(file);}return out;}
  async searchPaths(target:RepositoryTarget,terms:string[],maxResults=this.limits.maxSearchResults){const tree=await this.listTree(target),words=terms.map(x=>x.toLowerCase()).filter(Boolean);return tree.entries.filter(x=>x.type==="blob"&&words.some(w=>x.path.toLowerCase().includes(w))).slice(0,Math.min(maxResults,this.limits.maxSearchResults));}
  async searchContent(target:RepositoryTarget,terms:string[],candidates?:RepositoryTreeEntry[],maxResults=this.limits.maxSearchResults){const entries=candidates??(await this.listTree(target)).entries;const results:Array<{path:string;matchedTerms:string[];excerpt:string;size:number}>=[];let filesRead=0,totalBytes=0;for(const entry of entries){if(results.length>=maxResults||filesRead>=this.limits.maxFilesRead)break;if(entry.type!=="blob"||!this.isTextPath(entry.path)||entry.size&&entry.size>this.limits.maxFileBytes)continue;let file:RepositoryFile;try{file=await this.readFile(target,entry.path);filesRead++;totalBytes+=file.contentBytes;if(totalBytes>this.limits.maxTotalBytes)break;}catch(e){if(e instanceof RepositoryInspectionError&&["REPOSITORY_SECRET_FILE_BLOCKED","REPOSITORY_BINARY_UNSUPPORTED"].includes(e.code))continue;throw e;}const matched=terms.filter(t=>file.content.toLowerCase().includes(t.toLowerCase()));if(matched.length){const at=file.content.toLowerCase().indexOf(matched[0].toLowerCase()),excerpt=file.content.slice(Math.max(0,at-100),at+300).replace(/\s+/g," ");results.push({path:entry.path,matchedTerms:matched,excerpt,size:file.size});}}return results;}
  async readPullRequest(target:RepositoryTarget,pullNumber:number){try{const [pr,files]=await Promise.all([this.octokit.rest.pulls.get({owner:target.owner,repo:target.repo,pull_number:pullNumber}),this.octokit.paginate(this.octokit.rest.pulls.listFiles,{owner:target.owner,repo:target.repo,pull_number:pullNumber,per_page:100})]);return{number:pr.data.number,title:pr.data.title,state:pr.data.state,base:pr.data.base.ref,head:pr.data.head.ref,files:files.slice(0,this.limits.maxSearchResults).map((x:any)=>({path:x.filename,status:x.status,patch:x.patch?.slice(0,4000),truncated:(x.patch?.length??0)>4000}))};}catch(e){this.translate(e);}}
  async readCommit(target:RepositoryTarget,ref:string){try{const r=await this.octokit.rest.repos.getCommit({owner:target.owner,repo:target.repo,ref});return{sha:r.data.sha,message:r.data.commit.message,files:(r.data.files??[]).slice(0,this.limits.maxSearchResults).map((x:any)=>({path:x.filename,status:x.status,patch:x.patch?.slice(0,4000)}))};}catch(e){this.translate(e,"REPOSITORY_REF_NOT_FOUND");}}
  async readDiff(target:RepositoryTarget,base:string,head:string){try{const r=await this.octokit.rest.repos.compareCommits({owner:target.owner,repo:target.repo,base,head});return{status:r.data.status,files:(r.data.files??[]).slice(0,this.limits.maxSearchResults).map((x:any)=>({path:x.filename,status:x.status,patch:x.patch?.slice(0,4000)}))};}catch(e){this.translate(e,"REPOSITORY_REF_NOT_FOUND");}}
  async context(target:RepositoryTarget):Promise<RepositoryContext>{const repo=await this.getRepository(target),tree=await this.listTree(target),paths=tree.entries.filter(x=>x.type==="blob").map(x=>x.path),important=paths.filter(x=>/(^|\/)(package\.json|tsconfig\.json|README\.md|pyproject\.toml|build\.gradle|pom\.xml)$/i.test(x)).slice(0,20);let pkg:any={};if(paths.includes("package.json")){try{pkg=JSON.parse((await this.readFile({...target,ref:tree.ref},"package.json")).content);}catch{}}
    const extensions=[...new Set(paths.map(ext).filter(Boolean))];return{repository:`${target.owner}/${target.repo}`,defaultBranch:repo.defaultBranch,requestedRef:tree.ref,topLevelEntries:[...new Set(tree.entries.map(x=>x.path.split("/")[0]))].slice(0,100),importantFiles:important,languageHints:extensions.slice(0,12),frameworkHints:["react","next","express","typescript","vite"].filter(x=>JSON.stringify(pkg).toLowerCase().includes(x)),packageManager:paths.includes("pnpm-lock.yaml")?"pnpm":paths.includes("yarn.lock")?"yarn":paths.includes("package-lock.json")?"npm":undefined,entryPoints:paths.filter(x=>/(^|\/)(index|main|server|app)\.(ts|tsx|js|jsx|py)$/i.test(x)).slice(0,20),testCommands:pkg.scripts?.test?[`npm run test`]:[],buildCommands:pkg.scripts?.build?[`npm run build`]:[]};}
  private isTextPath(path:string){return !secretName.test(path)&&!binaryExtensions.test(path)&&(!lockfile.test(path))&&(textExtensions.has(ext(path))||/(^|\/)(gradle|properties|env\.example)$/i.test(path));}
  private assertReadablePath(path:string,allowLockfile:boolean){if(!path||path.startsWith("/")||path.includes(".."))throw new RepositoryInspectionError("REPOSITORY_INVALID");if(secretName.test(path))throw new RepositoryInspectionError("REPOSITORY_SECRET_FILE_BLOCKED");if(binaryExtensions.test(path)||(!this.isTextPath(path)&&!(allowLockfile&&lockfile.test(path))))throw new RepositoryInspectionError("REPOSITORY_BINARY_UNSUPPORTED");}
  private translate(error:unknown,fallback:RepositoryErrorCode="REPOSITORY_NOT_FOUND"):never{if(error instanceof RepositoryInspectionError)throw error;const status=(error as any)?.status;if(status===401||status===403)throw new RepositoryInspectionError("REPOSITORY_ACCESS_DENIED");if(status===404)throw new RepositoryInspectionError(fallback);throw new RepositoryInspectionError(fallback,(error as Error)?.message);}
}
