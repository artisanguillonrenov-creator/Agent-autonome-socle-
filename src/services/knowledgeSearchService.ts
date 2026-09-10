import { GitHubRepositoryReader, RepositoryInspectionError, normalizeRepositoryText, parseGitHubRepository, type RepositoryContext, type RepositoryFile, type RepositoryTarget } from "./githubRepositoryReader.js";

export type SearchConfidence="HIGH"|"MEDIUM"|"LOW";
export interface KnowledgeMatch {path:string;reason:string;score:number;relevance:SearchConfidence;matchedTerms?:string[];excerpt?:string;size?:number;truncated:boolean}
export interface KnowledgeSearchResult {query:string;source:"REPOSITORY";repository:string;ref:string;matches:KnowledgeMatch[];recommendedFiles:Array<{path:string;reason:string;confidence:SearchConfidence}>;context:RepositoryContext;truncated:boolean}
export interface RepositoryAuditFinding {title:string;severity:"BLOCKER"|"HIGH"|"MEDIUM"|"LOW"|"INFO";files:string[];evidence:string;impact:string;recommendation:string}

const stop=new Set(["dans","avec","pour","quoi","comment","trouve","trouver","regarde","code","where","find","the","and"]),synonyms:Record<string,string[]>={parametres:["settings"],settings:["parametres"],depot:["repository"],repository:["depot"],fichier:["file"],file:["fichier"],fonction:["function"],function:["fonction"]};
function terms(query:string,pathHints:string[]=[]){
  const initial=[...normalizeRepositoryText(query).split(/[^a-z0-9_.-]+/),...pathHints.map(normalizeRepositoryText)].filter(x=>x.length>2&&!stop.has(x));
  const expanded=initial.flatMap(x=>[x,...(synonyms[x]??[])]);
  return [...new Set(expanded)].slice(0,16);
}
function confidence(score:number):SearchConfidence{return score>=70?"HIGH":score>=35?"MEDIUM":"LOW";}

export class KnowledgeSearchService {
  constructor(readonly reader:GitHubRepositoryReader){}
  async search(input:{query:string;repository:string|RepositoryTarget;pathHints?:string[];fileTypes?:string[];maxResults?:number}):Promise<KnowledgeSearchResult>{
    const target=parseGitHubRepository(input.repository),repo=await this.reader.getRepository(target),ref=target.ref??repo.defaultBranch,queryTerms=terms(input.query,input.pathHints),max=Math.min(input.maxResults??20,this.reader.limits.maxSearchResults);
    const tree=await this.reader.listTree({...target,ref}),files=tree.entries.filter(x=>x.type==="blob"&&(!input.fileTypes?.length||input.fileTypes.some(t=>x.path.toLowerCase().endsWith(t.startsWith(".")?t.toLowerCase():`.${t.toLowerCase()}`))));
    const allPathHits=files.filter(x=>queryTerms.some(t=>normalizeRepositoryText(x.path).includes(t))),pathHits=allPathHits.slice(0,max);
    const structural=files.filter(x=>/(^|\/)(package\.json|readme\.md|.*(?:index|main|app|server|registry|config).(?:ts|tsx|js|jsx|json))$/i.test(x.path));
    // Phase 2 remains read-only and bounded: code-search candidates first, then source files before documentation.
    const codeHits=await this.reader.searchCodePaths({...target,ref},queryTerms,max),broader=files.filter(x=>/\.(?:ts|tsx|js|jsx|py|java|kt)$/i.test(x.path)).sort((a,b)=>a.path.split("/").length-b.path.split("/").length||a.path.localeCompare(b.path));
    const candidates=[...pathHits,...codeHits,...structural,...broader].filter((x,i,a)=>a.findIndex(y=>y.path===x.path)===i);
    const contentSearch=await this.reader.searchContent({...target,ref},queryTerms,candidates,max),byPath=new Map<string,KnowledgeMatch>();
    for(const hit of pathHits){const matched=queryTerms.filter(t=>normalizeRepositoryText(hit.path).includes(t)),score=Math.min(90,25+matched.length*25);byPath.set(hit.path,{path:hit.path,reason:`Path matches: ${matched.join(", ")}`,score,relevance:confidence(score),matchedTerms:matched,size:hit.size,truncated:false});}
    for(const hit of contentSearch.matches){const existing=byPath.get(hit.path),score=Math.min(100,(existing?.score??10)+hit.matchedTerms.length*30);byPath.set(hit.path,{path:hit.path,reason:`${existing?.reason?`${existing.reason}; `:""}Content matches: ${hit.matchedTerms.join(", ")}`,score,relevance:confidence(score),matchedTerms:[...new Set([...(existing?.matchedTerms??[]),...hit.matchedTerms])],excerpt:hit.excerpt,size:hit.size,truncated:hit.excerpt.length>=400});}
    const matches=[...byPath.values()].sort((a,b)=>b.score-a.score).slice(0,max);if(!matches.length)throw new RepositoryInspectionError("REPOSITORY_SEARCH_NO_RESULT");
    const context=await this.reader.context({...target,ref});return{query:input.query,source:"REPOSITORY",repository:`${target.owner}/${target.repo}`,ref,matches,recommendedFiles:matches.slice(0,5).map(x=>({path:x.path,reason:x.reason,confidence:x.relevance})),context,truncated:contentSearch.truncated||allPathHits.length>pathHits.length||byPath.size>matches.length};
  }
  async audit(repository:string|RepositoryTarget):Promise<{repository:string;ref:string;context:RepositoryContext;findings:RepositoryAuditFinding[];readOnly:true}>{
    const target=parseGitHubRepository(repository),context=await this.reader.context(target),findings:RepositoryAuditFinding[]=[];
    const tree=await this.reader.listTree({...target,ref:context.requestedRef}),architectural=tree.entries.filter(x=>x.type==="blob"&&/(^|\/)(package\.json|tsconfig.*\.json|readme\.md|.*config\.(ts|js|json)|.*registry\.ts|.*router\.ts)$/i.test(x.path)),selected=[...new Set([...context.importantFiles,...context.entryPoints,...architectural.map(x=>x.path)])].slice(0,Math.min(12,this.reader.limits.maxFilesRead));
    let readable:RepositoryFile[]=[];try{readable=(await this.reader.readFiles({...target,ref:context.requestedRef},selected)).files;}catch(e){if(!(e instanceof RepositoryInspectionError))throw e;}
    for(const file of readable){const marker=file.content.match(/\b(?:TODO|FIXME)\b[^\n]{0,120}/i);if(marker)findings.push({title:"Unresolved maintenance marker observed",severity:"LOW",files:[file.path],evidence:marker[0],impact:"The marked implementation may be incomplete or carry known debt.",recommendation:"Review the marker and either resolve it or track it explicitly."});const imports=[...file.content.matchAll(/(?:from\s+|require\()["']([^"']+)["']/g)].map(x=>x[1]);if(imports.some(x=>x.startsWith(".")&&!tree.entries.some(e=>normalizeRepositoryText(e.path).includes(normalizeRepositoryText(x.replace(/^\.\//,""))))))findings.push({title:"Relative import requires verification",severity:"INFO",files:[file.path],evidence:"A relative import could not be resolved from the bounded repository tree.",impact:"It may be generated, extension-resolved, or missing; bounded inspection cannot decide.",recommendation:"Confirm the import with the project compiler before changing code."});}
    if(!context.importantFiles.some(x=>/^readme\.md$/i.test(x)))findings.push({title:"Repository documentation entry point not found",severity:"LOW",files:[],evidence:"No top-level README.md was observed in the bounded tree.",impact:"Onboarding and maintenance may be harder.",recommendation:"Add a concise README with architecture and commands."});
    if(context.packageManager&&!context.testCommands.length)findings.push({title:"No package test command observed",severity:"MEDIUM",files:["package.json"],evidence:"package.json was observed without a test script.",impact:"Regressions may reach pull requests undetected.",recommendation:"Define and run an automated test script."});
    if(!findings.length)findings.push({title:"No observable issue in bounded audit",severity:"INFO",files:readable.map(x=>x.path),evidence:`Inspected ${readable.length} important/entry-point files from a bounded tree.`,impact:"The inspection is intentionally incomplete and is not proof that the repository is defect-free.",recommendation:"Run the observed test/build commands and targeted static analysis for deeper assurance."});
    return{repository:context.repository,ref:context.requestedRef,context,findings,readOnly:true};
  }
}
