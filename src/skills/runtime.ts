import { randomUUID } from "node:crypto";
import type { SkillDefinition, SkillContext } from "../types.js";
import type { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import type { Planner } from "../planning/planner.js";
import type { PlanRunner } from "../planning/planRunner.js";
import { TaskStore } from "../tasks/taskStore.js";
import { WorkflowRegistry } from "../workflows/workflowRegistry.js";
import { canonicalSkillCatalog } from "./catalog.js";
import { config } from "../config.js";
import { readDocument, searchDocument } from "../workbench/documentEngine.js";
import { indexWorkspaceDocument, removeWorkspaceDocumentIndex, searchWorkspaceKnowledge } from "../workbench/knowledgeIndex.js";
import { VectorMemory } from "../memory/vectorMemory.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import {
  listSheets,
  inspectSpreadsheet,
  readRange,
  loadTabularDataset,
  applyFilters,
  applySort,
  computeAggregate,
  exportCsv,
  exportXlsx,
  type FilterCondition,
  type SortSpec,
  type AggregateOperation,
} from "../workbench/spreadsheetEngine.js";
import { runDataAnalysis, type AnalysisRequest } from "../workbench/dataAnalysisEngine.js";
import { runDatabaseQuery } from "../workbench/databaseEngine.js";
import { generateReport } from "../workbench/reportEngine.js";
import { WORKBENCH_LIMITS } from "../workbench/limits.js";
import { createGithubReadOnlyClient, type GithubReadOnlyClient } from "../repository/githubReadOnlyClient.js";
import {
  resolveRepoTarget,
  resolveRef as resolveRepositoryRef,
  browseTree,
  readRepositoryFile,
  readRepositoryFiles,
  searchRepositoryPath,
  searchRepositoryCode,
  readPullRequest,
  readPullRequestFiles,
  readPullRequestDiff,
  readCommit,
  readDiffBetweenVersions,
  buildRepositoryContext,
  auditRepository,
} from "../repository/repositoryIntelligenceEngine.js";

const schema=(properties:Record<string,unknown>,required:string[]=[]):SkillDefinition["parameters"]=>({type:"object",properties,required,additionalProperties:false});
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const strings=(v:unknown):string[]=>Array.isArray(v)&&v.every(x=>typeof x==="string")?v:[];
const nonEmpty=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0;
const validTime=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number.isFinite(value)&&(value as number)>=0;
const asColumns=(value:unknown):number[]|undefined=>{if(value===undefined)return undefined;if(!Array.isArray(value)||!value.every(v=>Number.isInteger(v)))throw new Error("SPREADSHEET_RANGE_INVALID");return value as number[];};
const asFilterConditions=(value:unknown):FilterCondition[]=>{if(value===undefined)return[];if(!Array.isArray(value))throw new Error("SPREADSHEET_FILTER_INVALID");return value.map(v=>{if(!v||typeof v!=="object"||Array.isArray(v))throw new Error("SPREADSHEET_FILTER_INVALID");const f=v as Record<string,unknown>;if(typeof f.column!=="string"||!f.column||typeof f.operator!=="string")throw new Error("SPREADSHEET_FILTER_INVALID");return{column:f.column,operator:f.operator as FilterCondition["operator"],value:f.value};});};
const asSortSpecs=(value:unknown):SortSpec[]=>{if(value===undefined)return[];if(!Array.isArray(value)||!value.every(v=>v&&typeof v==="object"&&!Array.isArray(v)))throw new Error("SPREADSHEET_SORT_INVALID");return value.map(v=>{const s=v as Record<string,unknown>;if(typeof s.column!=="string"||!s.column)throw new Error("SPREADSHEET_SORT_INVALID");return{column:s.column,direction:s.direction==="desc"?"desc":"asc"} as SortSpec;});};
function validateRepeat(value:unknown):void {if(value!==undefined&&(!Number.isSafeInteger(value)||(value as number)<=0))throw new Error("INVALID_SCHEDULE");}
export function createRuntimeSkills(orchestrator:ServiceOrchestrator,planner:Planner,planRunner:PlanRunner,workflows:WorkflowRegistry,repositoryClient:GithubReadOnlyClient=createGithubReadOnlyClient(),vectorMemory:VectorMemory=new VectorMemory(new LocalHashingEmbeddingProvider())):SkillDefinition[]{
  const tasks=new TaskStore();const base=new Map(canonicalSkillCatalog.map(s=>[s.id!,{...s}]));
  const define=(id:string,parameters:SkillDefinition["parameters"],handler:NonNullable<SkillDefinition["handler"]>)=>Object.assign(base.get(id)!,{parameters,handler});
  const dispatch=(capability:string,input:Record<string,unknown>,context:Record<string,unknown>,workspaceId?:string)=>orchestrator.dispatchCapability({action:"DISPATCH_CAPABILITY",capability,objective:String(input.objective??"").trim(),context,constraints:strings(input.constraints)},{executionMode:input.executionMode==="background"?"background":"foreground",workspaceId});

  define("software_development",schema({objective:{type:"string"},filePath:{type:"string"},instructions:{type:"string"},exactContent:{type:"string"},targetBranch:{type:"string"},targetPr:{type:"integer"},createIfMissing:{type:"boolean"},constraints:{type:"array"},executionMode:{type:"string",enum:["foreground","background"]}},["objective","filePath"]),async i=>{
    const directives=[typeof i.targetBranch==="string"?`TARGET_BRANCH=${i.targetBranch}`:null,Number.isInteger(i.targetPr)?`TARGET_PR=${i.targetPr}`:null,typeof i.instructions==="string"?i.instructions:null].filter(Boolean).join("\n");
    return JSON.stringify(await dispatch("software_development",i,{filePath:i.filePath,instructions:directives,exactContent:i.exactContent,createIfMissing:i.createIfMissing===true,neverAutoMerge:true}));
  });
  define("deep_research",schema({objective:{type:"string"},queries:{type:"array"},maxResultsPerQuery:{type:"integer"},constraints:{type:"array"},workspaceId:{type:"string"}},["objective"]),async i=>{
    const workspaceId=typeof i.workspaceId==="string"?i.workspaceId:orchestrator.workspaces.create({name:"Recherche",ownerType:"ADHOC",ownerId:`research-${randomUUID()}`}).id;
    const result=await dispatch("deep_research",i,{queries:i.queries,maxResultsPerQuery:i.maxResultsPerQuery},workspaceId);
    return JSON.stringify({...result,workspaceId,artifacts:orchestrator.artifacts.listByOperation(result.taskId)});
  });
  define("file_management",schema({action:{type:"string",enum:["LIST","READ","WRITE","DELETE"]},workspaceId:{type:"string"},path:{type:"string"},content:{type:"string"},encoding:{type:"string"}},["action","workspaceId"]),async i=>{
    const result=await dispatch("file_management",{...i,objective:`${i.action} workspace file`},{action:i.action,path:i.path,...(i.encoding==="base64"?{contentBase64:i.content}:{text:i.content})},String(i.workspaceId));
    // projects.autoIndexing (nécessite projects.knowledgeRag) : maintient l'index RAG
    // cohérent avec le contenu réel du workspace — jamais de doublon (delete-then-insert
    // par source_key), jamais d'entrée fantôme après suppression d'un fichier.
    if(result.status==="COMPLETED"&&config.projects.autoIndexing&&config.projects.knowledgeRag&&nonEmpty(i.path)){
      if(i.action==="WRITE")await indexWorkspaceDocument(orchestrator.workspaces,vectorMemory,String(i.workspaceId),i.path).catch(()=>undefined);
      else if(i.action==="DELETE")removeWorkspaceDocumentIndex(vectorMemory,String(i.workspaceId),i.path);
    }
    return JSON.stringify({...result,workspaceId:i.workspaceId,artifacts:orchestrator.artifacts.listByOperation(result.taskId)});
  });
  define("inspect_task",schema({id:{type:"string"},type:{type:"string",enum:["operation","plan","schedule"]}},["id"]),async i=>{const id=String(i.id),type=i.type;const found=[!type||type==="operation"?orchestrator.store.getOperation(id):null,!type||type==="plan"?planner.getRun(id):null,!type||type==="schedule"?tasks.get(id):null].filter(Boolean);if(found.length>1)return"AMBIGUOUS_TASK_ID";if(!found.length)return"TASK_NOT_FOUND";return JSON.stringify(found[0]);});
  define("cancel_task",schema({id:{type:"string"},type:{type:"string",enum:["operation","plan","schedule"]}},["id"]),async i=>{const id=String(i.id);if(i.type==="plan"||(!i.type&&planner.getRun(id))){const r=planRunner.cancel(id);return r?JSON.stringify({id,status:r.status,result:r.status==="CANCELLED"?"cancelled":"cancellation_requested"}):"TASK_NOT_FOUND";}if(i.type==="schedule"||(!i.type&&tasks.get(id)))return JSON.stringify({id,result:tasks.setEnabled(id,false)?"cancelled":"TASK_NOT_FOUND"});const r=orchestrator.store.cancel(id);return r?JSON.stringify({id,result:r.cancelled?"cancelled":r.requested?"cancellation_requested":"not_cancelled",status:r.operation.status}):"TASK_NOT_FOUND";});
  const schedule=async(i:Record<string,unknown>,watch=false)=>{if(!nonEmpty(i.title)||!validTime(i.nextRunAt)||!nonEmpty(i.capability)||!nonEmpty(i.objective))throw new Error("INVALID_SCHEDULE");validateRepeat(i.repeatIntervalMs);if(!orchestrator.registry.findServiceForCapability(i.capability))return"UNKNOWN_CAPABILITY";return JSON.stringify(tasks.createSchedule({title:i.title.trim(),taskType:watch?"WATCH":"DISPATCH",nextRunAt:i.nextRunAt,repeatIntervalMs:i.repeatIntervalMs as number|undefined,payload:{action:"DISPATCH_CAPABILITY",capability:i.capability,objective:i.objective.trim(),context:object(i.context),constraints:strings(i.constraints)}}));};
  define("schedule_task",schema({action:{type:"string",enum:["CREATE_REMINDER","CREATE_DISPATCH","LIST","ENABLE","DISABLE","COMPLETE"]},id:{type:"string"},title:{type:"string"},nextRunAt:{type:"integer"},capability:{type:"string"},objective:{type:"string"},context:{type:"object"},constraints:{type:"array"},repeatIntervalMs:{type:"integer"}},["action"]),async i=>{switch(i.action){case"LIST":return JSON.stringify(tasks.listSchedules());case"ENABLE":case"DISABLE":case"COMPLETE":if(!nonEmpty(i.id))throw new Error("INVALID_SCHEDULE");return JSON.stringify({ok:i.action==="COMPLETE"?tasks.complete(i.id):tasks.setEnabled(i.id,i.action==="ENABLE")});case"CREATE_REMINDER":if(!nonEmpty(i.title)||!validTime(i.nextRunAt))throw new Error("INVALID_SCHEDULE");validateRepeat(i.repeatIntervalMs);return JSON.stringify(tasks.createSchedule({title:i.title.trim(),taskType:"REMINDER",nextRunAt:i.nextRunAt,repeatIntervalMs:i.repeatIntervalMs as number|undefined}));case"CREATE_DISPATCH":return schedule(i);default:throw new Error("INVALID_SCHEDULE_ACTION");}});
  define("monitor_condition",schema({title:{type:"string"},objective:{type:"string"},nextRunAt:{type:"integer"},repeatIntervalMs:{type:"integer"},capability:{type:"string"},context:{type:"object"},constraints:{type:"array"}},["title","objective","nextRunAt","capability"]),async i=>schedule(i,true));
  define("execute_workflow",schema({workflowId:{type:"string"},workflowName:{type:"string"},inputs:{type:"object"}},["inputs"]),async(i,ctx)=>{
    const key=String(i.workflowId??i.workflowName??""),workflow=workflows.get(key);if(!workflow||workflow.status!=="ACTIVE")throw new Error("WORKFLOW_NOT_ACTIVE");
    if(workflow.name==="monitor_web"){
      const input=object(i.inputs),compiled=workflows.compile(workflow,input);
      if(!nonEmpty(input.title)||!nonEmpty(input.objective)||!validTime(input.firstRunAt))throw new Error("WORKFLOW_INPUT_INVALID");
      validateRepeat(input.repeatIntervalMs);
      const title=input.title.trim(),firstRunAt=input.firstRunAt,repeatIntervalMs=input.repeatIntervalMs as number;
      const created=workflows.executeSchedule(key,input,orchestrator.registry,ctx.toolCallId??"",id=>tasks.get(id),()=>tasks.createSchedule({title,taskType:"WATCH",nextRunAt:firstRunAt,repeatIntervalMs,payload:{action:"DISPATCH_CAPABILITY",capability:"deep_research",objective:compiled.objective,context:{queries:input.queries},constraints:[]}}));
      return JSON.stringify({workflowId:workflow.id,workflowVersion:workflow.version,scheduleId:created.id,nextRunAt:created.nextRunAt,enabled:created.enabled});
    }
    const run=workflows.execute(key,object(i.inputs),planner,orchestrator.registry,ctx.toolCallId??"");return JSON.stringify({workflowId:workflow.id,workflowVersion:workflow.version,planRunId:run.id,workspaceId:run.workspaceId,status:run.status});
  });
  define("manage_skill",schema({action:{type:"string"},skillId:{type:"string"},workflowId:{type:"string"},planRunId:{type:"string"}},["action"]),async(i,ctx:SkillContext)=>{const registry=ctx.skillRegistry;switch(i.action){case"LIST":return JSON.stringify(registry.list().map((s:SkillDefinition)=>({id:s.id,enabled:registry.isEnabled(s)})));case"ENABLE":case"DISABLE":registry.setEnabled(String(i.skillId),i.action==="ENABLE");return JSON.stringify({ok:true});case"LIST_WORKFLOWS":return JSON.stringify(workflows.list());case"LEARN_WORKFLOW_FROM_PLAN":return JSON.stringify(workflows.learnFromPlan(String(i.planRunId),planner));case"APPROVE_WORKFLOW":return JSON.stringify({ok:workflows.setStatus(String(i.workflowId),"ACTIVE",orchestrator.registry)});case"DISABLE_WORKFLOW":return JSON.stringify({ok:workflows.setStatus(String(i.workflowId),"DISABLED",orchestrator.registry)});case"ARCHIVE_WORKFLOW":return JSON.stringify({ok:workflows.setStatus(String(i.workflowId),"ARCHIVED",orchestrator.registry)});default:return"INVALID_MANAGE_ACTION";}});
  define("document_work",schema({action:{type:"string",enum:["READ","SEARCH","INDEX","RAG_SEARCH"]},workspaceId:{type:"string"},path:{type:"string"},query:{type:"string"},caseSensitive:{type:"boolean"},maxResults:{type:"integer"},contextChars:{type:"integer"},topK:{type:"integer"}},["action","workspaceId"]),async i=>{
    const workspaceId=String(i.workspaceId);
    if(i.action==="READ"){if(!nonEmpty(i.path))throw new Error("DOCUMENT_PATH_REQUIRED");return JSON.stringify(await readDocument(orchestrator.workspaces,workspaceId,i.path));}
    if(i.action==="SEARCH"){if(!nonEmpty(i.path))throw new Error("DOCUMENT_PATH_REQUIRED");if(!nonEmpty(i.query))throw new Error("DOCUMENT_SEARCH_QUERY_REQUIRED");return JSON.stringify(await searchDocument(orchestrator.workspaces,workspaceId,i.path,i.query,{caseSensitive:i.caseSensitive===true,maxResults:i.maxResults as number|undefined,contextChars:i.contextChars as number|undefined}));}
    // projects.knowledgeRag : RAG projet réel (embeddings + VectorMemory, scopé au workspace).
    if(i.action==="INDEX"){
      if(!config.projects.knowledgeRag)throw new Error("KNOWLEDGE_RAG_DISABLED");
      if(!nonEmpty(i.path))throw new Error("DOCUMENT_PATH_REQUIRED");
      return JSON.stringify(await indexWorkspaceDocument(orchestrator.workspaces,vectorMemory,workspaceId,i.path));
    }
    if(i.action==="RAG_SEARCH"){
      if(!config.projects.knowledgeRag)throw new Error("KNOWLEDGE_RAG_DISABLED");
      if(!nonEmpty(i.query))throw new Error("DOCUMENT_SEARCH_QUERY_REQUIRED");
      return JSON.stringify(await searchWorkspaceKnowledge(vectorMemory,workspaceId,i.query,Number.isInteger(i.topK)?i.topK as number:5));
    }
    throw new Error("DOCUMENT_ACTION_INVALID");
  });

  define("knowledge_search",schema({action:{type:"string",enum:["TREE","READ_FILE","READ_MULTIPLE_FILES","SEARCH_PATH","SEARCH_CODE","READ_PR","READ_PR_FILES","READ_PR_DIFF","READ_COMMIT","READ_DIFF","BUILD_CONTEXT","AUDIT"]},owner:{type:"string"},repo:{type:"string"},repoUrl:{type:"string"},ref:{type:"string"},path:{type:"string"},paths:{type:"array",items:{type:"string"}},query:{type:"string"},caseSensitive:{type:"boolean"},maxResults:{type:"integer"},extensions:{type:"array",items:{type:"string"}},prNumber:{type:"integer"},sha:{type:"string"},base:{type:"string"},head:{type:"string"}},["action"]),async i=>{
    const target=resolveRepoTarget(i);
    switch(i.action){
      case"TREE":{const ref=await resolveRepositoryRef(repositoryClient,target,i.ref);return JSON.stringify(await browseTree(repositoryClient,target,ref));}
      case"READ_FILE":{const ref=await resolveRepositoryRef(repositoryClient,target,i.ref);return JSON.stringify(await readRepositoryFile(repositoryClient,target,ref,String(i.path??"")));}
      case"READ_MULTIPLE_FILES":{const ref=await resolveRepositoryRef(repositoryClient,target,i.ref);return JSON.stringify(await readRepositoryFiles(repositoryClient,target,ref,strings(i.paths)));}
      case"SEARCH_PATH":{const ref=await resolveRepositoryRef(repositoryClient,target,i.ref);return JSON.stringify(await searchRepositoryPath(repositoryClient,target,ref,String(i.query??""),{caseSensitive:i.caseSensitive===true,maxResults:i.maxResults as number|undefined}));}
      case"SEARCH_CODE":{const ref=await resolveRepositoryRef(repositoryClient,target,i.ref);return JSON.stringify(await searchRepositoryCode(repositoryClient,target,ref,String(i.query??""),{caseSensitive:i.caseSensitive===true,maxResults:i.maxResults as number|undefined,extensions:strings(i.extensions)}));}
      case"READ_PR":return JSON.stringify(await readPullRequest(repositoryClient,target,i.prNumber));
      case"READ_PR_FILES":return JSON.stringify(await readPullRequestFiles(repositoryClient,target,i.prNumber));
      case"READ_PR_DIFF":return JSON.stringify(await readPullRequestDiff(repositoryClient,target,i.prNumber));
      case"READ_COMMIT":return JSON.stringify(await readCommit(repositoryClient,target,String(i.sha??"")));
      case"READ_DIFF":return JSON.stringify(await readDiffBetweenVersions(repositoryClient,target,String(i.base??""),String(i.head??"")));
      case"BUILD_CONTEXT":{const ref=await resolveRepositoryRef(repositoryClient,target,i.ref);return JSON.stringify(await buildRepositoryContext(repositoryClient,target,ref,String(i.query??"")));}
      case"AUDIT":return JSON.stringify(await auditRepository(repositoryClient,target,{ref:i.ref as string|undefined,prNumber:i.prNumber as number|undefined}));
      default:throw new Error("REPOSITORY_ACTION_INVALID");
    }
  });

  define("spreadsheet_work",schema({action:{type:"string",enum:["LIST_SHEETS","INSPECT","READ_RANGE","FILTER","SORT","AGGREGATE","EXPORT_CSV","EXPORT_XLSX"]},workspaceId:{type:"string"},path:{type:"string"},sheet:{type:"string"},startRow:{type:"integer"},endRow:{type:"integer"},columns:{type:"array",items:{type:"integer"}},filters:{type:"array",items:{type:"object"}},sortBy:{type:"array",items:{type:"object"}},column:{type:"string"},operation:{type:"string",enum:["COUNT","SUM","MEAN","MIN","MAX"]},targetPath:{type:"string"}},["action","workspaceId","path"]),async i=>{
    const workspaceId=String(i.workspaceId),path=String(i.path),sheet=nonEmpty(i.sheet)?i.sheet:undefined;
    const datasetLimits={maxRows:WORKBENCH_LIMITS.SPREADSHEET_MAX_ROWS_PER_READ,maxColumns:WORKBENCH_LIMITS.SPREADSHEET_MAX_COLUMNS,maxCells:WORKBENCH_LIMITS.SPREADSHEET_MAX_CELLS_PER_READ};
    switch(i.action){
      case"LIST_SHEETS":return JSON.stringify(await listSheets(orchestrator.workspaces,workspaceId,path));
      case"INSPECT":return JSON.stringify(await inspectSpreadsheet(orchestrator.workspaces,workspaceId,path,sheet));
      case"READ_RANGE":{if(!Number.isInteger(i.startRow))throw new Error("SPREADSHEET_RANGE_INVALID");return JSON.stringify(await readRange(orchestrator.workspaces,workspaceId,path,{sheet,startRow:i.startRow as number,endRow:i.endRow as number|undefined,columns:asColumns(i.columns)}));}
      case"FILTER":{const dataset=await loadTabularDataset(orchestrator.workspaces,workspaceId,path,{sheet,...datasetLimits});const rows=applyFilters(dataset.headers,dataset.rows,asFilterConditions(i.filters));return JSON.stringify({headers:dataset.headers,rows,rowCount:rows.length,truncated:dataset.truncated,totalRowsKnown:dataset.totalRowsKnown,totalRows:dataset.totalRows,warnings:dataset.warnings});}
      case"SORT":{const dataset=await loadTabularDataset(orchestrator.workspaces,workspaceId,path,{sheet,...datasetLimits});const rows=applySort(dataset.headers,dataset.rows,asSortSpecs(i.sortBy));return JSON.stringify({headers:dataset.headers,rows,rowCount:rows.length,truncated:dataset.truncated,totalRowsKnown:dataset.totalRowsKnown,totalRows:dataset.totalRows,warnings:dataset.warnings});}
      case"AGGREGATE":{if(!nonEmpty(i.column)||!nonEmpty(i.operation))throw new Error("SPREADSHEET_AGGREGATE_OPERATION_INVALID");const dataset=await loadTabularDataset(orchestrator.workspaces,workspaceId,path,{sheet,...datasetLimits});const value=computeAggregate(dataset.headers,dataset.rows,i.column,i.operation as AggregateOperation);return JSON.stringify({column:i.column,operation:i.operation,value,truncated:dataset.truncated,totalRowsKnown:dataset.totalRowsKnown,totalRows:dataset.totalRows,warnings:dataset.warnings});}
      case"EXPORT_CSV":return JSON.stringify(await exportCsv(orchestrator.workspaces,orchestrator.artifacts,workspaceId,{path,sheet,filters:asFilterConditions(i.filters),sortBy:asSortSpecs(i.sortBy),targetPath:i.targetPath as string|undefined}));
      case"EXPORT_XLSX":return JSON.stringify(await exportXlsx(orchestrator.workspaces,orchestrator.artifacts,workspaceId,{path,sheet,filters:asFilterConditions(i.filters),sortBy:asSortSpecs(i.sortBy),targetPath:i.targetPath as string|undefined}));
      default:throw new Error("SPREADSHEET_ACTION_INVALID");
    }
  });

  define("data_analysis",schema({workspaceId:{type:"string"},path:{type:"string"},sheet:{type:"string"},action:{type:"string",enum:["DESCRIBE","COUNT","SUM","MEAN","MEDIAN","MIN","MAX","STDDEV","GROUP_BY","CORRELATION","TOP_N","BOTTOM_N","OUTLIERS","DISTRIBUTION","TIME_SERIES"]},column:{type:"string"},columnX:{type:"string"},columnY:{type:"string"},groupColumn:{type:"string"},aggregateColumn:{type:"string"},aggregateOperation:{type:"string",enum:["COUNT","SUM","MEAN","MIN","MAX"]},n:{type:"integer"},buckets:{type:"integer"},granularity:{type:"string",enum:["DAY","WEEK","MONTH","YEAR"]},dateColumn:{type:"string"},valueColumn:{type:"string"}},["workspaceId","path","action"]),async i=>{
    const request:AnalysisRequest={workspaceId:String(i.workspaceId),path:String(i.path),sheet:nonEmpty(i.sheet)?i.sheet:undefined,action:i.action as AnalysisRequest["action"],column:i.column as string|undefined,columnX:i.columnX as string|undefined,columnY:i.columnY as string|undefined,groupColumn:i.groupColumn as string|undefined,aggregateColumn:i.aggregateColumn as string|undefined,aggregateOperation:i.aggregateOperation as AggregateOperation|undefined,n:i.n as number|undefined,buckets:i.buckets as number|undefined,granularity:i.granularity as AnalysisRequest["granularity"],dateColumn:i.dateColumn as string|undefined,valueColumn:i.valueColumn as string|undefined};
    return JSON.stringify(await runDataAnalysis(orchestrator.workspaces,request));
  });

  define("database_query",schema({workspaceId:{type:"string"},path:{type:"string"},sql:{type:"string"}},["workspaceId","path","sql"]),async i=>JSON.stringify(runDatabaseQuery(orchestrator.workspaces,String(i.workspaceId),String(i.path),String(i.sql))));

  define("report_generation",schema({workspaceId:{type:"string"},title:{type:"string"},content:{type:"string"},format:{type:"string",enum:["MARKDOWN","JSON"]},targetPath:{type:"string"},metadata:{type:"object"}},["workspaceId","title","content","format"]),async i=>JSON.stringify(generateReport(orchestrator.artifacts,{workspaceId:String(i.workspaceId),title:String(i.title),content:String(i.content),format:i.format as"MARKDOWN"|"JSON",targetPath:i.targetPath as string|undefined,metadata:object(i.metadata)})));

  if(config.webSearch.provider==="none"){const web=base.get("web_search")!;web.availability="UNAVAILABLE";web.unavailableReason="Web provider is not configured";delete web.handler;}
  for(const s of base.values())if(s.serviceCapability&&!orchestrator.registry.findServiceForCapability(s.serviceCapability)){s.availability="UNAVAILABLE";s.unavailableReason=`Service unavailable: ${s.serviceCapability}`;delete s.handler;}
  return [...base.values()];
}
