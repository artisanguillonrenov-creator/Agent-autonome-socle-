import { GitHubRepositoryReader, RepositoryInspectionError, parseGitHubRepository, type RepositoryContext, type RepositoryTarget } from "./githubRepositoryReader.js";

export type SearchConfidence="HIGH"|"MEDIUM"|"LOW";
export interface KnowledgeMatch {path:string;reason:string;score:number;relevance:SearchConfidence;matchedTerms?:string[];excerpt?:string;size?:number;truncated:boolean}
export interface KnowledgeSearchResult {query:string;source:"REPOSITORY";repository:string;ref:string;matches:KnowledgeMatch[];recommendedFiles:Array<{path:string;reason:string;confidence:SearchConfidence}>;context:RepositoryContext;truncated:boolean}
export interface RepositoryAuditFinding {title:string;severity:"BLOCKER"|"HIGH"|"MEDIUM"|"LOW"|"INFO";files:string[];evidence:string;impact:string;recommendation:string}

const stop=new Set(["dans","avec","pour","quoi","comment","trouve","trouver","regarde","code","dépôt","depot","repository","where","find","the","and"]);
function terms(query:string,pathHints:string[]=[]){return[...new Set([...query.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().split(/[^a-z0-9_.-]+/),...pathHints].filter(x=>x.length>2&&!stop.has(x)))].slice(0,12);}
function confidence(score:number):SearchConfidence{return score>=70?"HIGH":score>=35?"MEDIUM":"LOW";}

export class KnowledgeSearchService {
  constructor(readonly reader:GitHubRepositoryReader){}
  async search(input:{query:string;repository:string|RepositoryTarget;pathHints?:string[];fileTypes?:string[];maxResults?:number}):Promise<KnowledgeSearchResult>{
    const target=parseGitHubRepository(input.repository),repo=await this.reader.getRepository(target),ref=target.ref??repo.defaultBranch,queryTerms=terms(input.query,input.pathHints),max=Math.min(input.maxResults??20,this.reader.limits.maxSearchResults);
    const tree=await this.reader.listTree({...target,ref}),files=tree.entries.filter(x=>x.type==="blob"&&(!input.fileTypes?.length||input.fileTypes.some(t=>x.path.toLowerCase().endsWith(t.startsWith(".")?t.toLowerCase():`.${t.toLowerCase()}`))));
    const pathHits=files.filter(x=>queryTerms.some(t=>x.path.toLowerCase().includes(t))).slice(0,max);
    const likely=[...pathHits,...files.filter(x=>/(^|\/)(package\.json|readme\.md|.*(?:index|main|app|server).(?:ts|tsx|js|jsx))$/i.test(x.path))].filter((x,i,a)=>a.findIndex(y=>y.path===x.path)===i).slice(0,this.reader.limits.maxFilesRead);
    const contentHits=await this.reader.searchContent({...target,ref},queryTerms,likely,max),byPath=new Map<string,KnowledgeMatch>();
    for(const hit of pathHits){const matched=queryTerms.filter(t=>hit.path.toLowerCase().includes(t)),score=Math.min(90,25+matched.length*25);byPath.set(hit.path,{path:hit.path,reason:`Path matches: ${matched.join(", ")}`,score,relevance:confidence(score),matchedTerms:matched,size:hit.size,truncated:false});}
    for(const hit of contentHits){const existing=byPath.get(hit.path),score=Math.min(100,(existing?.score??10)+hit.matchedTerms.length*30);byPath.set(hit.path,{path:hit.path,reason:`${existing?.reason?`${existing.reason}; `:""}Content matches: ${hit.matchedTerms.join(", ")}`,score,relevance:confidence(score),matchedTerms:[...new Set([...(existing?.matchedTerms??[]),...hit.matchedTerms])],excerpt:hit.excerpt,size:hit.size,truncated:hit.excerpt.length>=400});}
    const matches=[...byPath.values()].sort((a,b)=>b.score-a.score).slice(0,max);if(!matches.length)throw new RepositoryInspectionError("REPOSITORY_SEARCH_NO_RESULT");
    const context=await this.reader.context({...target,ref});return{query:input.query,source:"REPOSITORY",repository:`${target.owner}/${target.repo}`,ref,matches,recommendedFiles:matches.slice(0,5).map(x=>({path:x.path,reason:x.reason,confidence:x.relevance})),context,truncated:byPath.size>matches.length};
  }
  async audit(repository:string|RepositoryTarget):Promise<{repository:string;ref:string;context:RepositoryContext;findings:RepositoryAuditFinding[];readOnly:true}>{
    const target=parseGitHubRepository(repository),context=await this.reader.context(target),findings:RepositoryAuditFinding[]=[];
    if(!context.importantFiles.some(x=>/^readme\.md$/i.test(x)))findings.push({title:"Repository documentation entry point not found",severity:"LOW",files:[],evidence:"No top-level README.md was observed in the bounded tree.",impact:"Onboarding and maintenance may be harder.",recommendation:"Add a concise README with architecture and commands."});
    if(context.packageManager&&!context.testCommands.length)findings.push({title:"No package test command observed",severity:"MEDIUM",files:["package.json"],evidence:"package.json was observed without a test script.",impact:"Regressions may reach pull requests undetected.",recommendation:"Define and run an automated test script."});
    if(!findings.length)findings.push({title:"No manifest-level issue detected",severity:"INFO",files:context.importantFiles,evidence:"Bounded inspection found documented entry points and commands.",impact:"This is not proof that the repository is defect-free.",recommendation:"Run targeted static analysis and tests for deeper assurance."});
    return{repository:context.repository,ref:context.requestedRef,context,findings,readOnly:true};
  }
}
