import { randomUUID } from "node:crypto";
import type { SkillDefinition, SkillContext } from "../types.js";
import type { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import type { Planner } from "../planning/planner.js";
import type { PlanRunner } from "../planning/planRunner.js";
import { TaskStore } from "../tasks/taskStore.js";
import { WorkflowRegistry } from "../workflows/workflowRegistry.js";
import { canonicalSkillCatalog } from "./catalog.js";
import { config } from "../config.js";
import { DocumentEngine } from "../workbench/documentEngine.js";
import { SpreadsheetEngine } from "../workbench/spreadsheetEngine.js";
import { DataAnalysisEngine } from "../workbench/dataAnalysisEngine.js";
import { DatabaseQueryEngine } from "../workbench/databaseQueryEngine.js";
import { ReportEngine } from "../workbench/reportEngine.js";
import type {
  AggregateOptions,
  FilterCondition,
  Finding,
  Provenance,
  ReportSection,
  SortCondition
} from "../workbench/workbenchTypes.js";

const WORKBENCH_REPORT_LIMITS = { maxSections: 200, maxTables: 50, maxTableRows: 5000, maxFindings: 200, maxSources: 200 };

const schema=(properties:Record<string,unknown>,required:string[]=[]):SkillDefinition["parameters"]=>({type:"object",properties,required,additionalProperties:false});
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const strings=(v:unknown):string[]=>Array.isArray(v)&&v.every(x=>typeof x==="string")?v:[];
const nonEmpty=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0;
const validTime=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number.isFinite(value)&&(value as number)>=0;
function validateRepeat(value:unknown):void {if(value!==undefined&&(!Number.isSafeInteger(value)||(value as number)<=0))throw new Error("INVALID_SCHEDULE");}
export function createRuntimeSkills(orchestrator:ServiceOrchestrator,planner:Planner,planRunner:PlanRunner,workflows:WorkflowRegistry):SkillDefinition[]{
  const tasks=new TaskStore();const base=new Map(canonicalSkillCatalog.map(s=>[s.id!,{...s}]));
  const define=(id:string,parameters:SkillDefinition["parameters"],handler:NonNullable<SkillDefinition["handler"]>)=>Object.assign(base.get(id)!,{parameters,handler});
  const dispatch=(capability:string,input:Record<string,unknown>,context:Record<string,unknown>,workspaceId?:string)=>orchestrator.dispatchCapability({action:"DISPATCH_CAPABILITY",capability,objective:String(input.objective??"").trim(),context,constraints:strings(input.constraints)},{executionMode:input.executionMode==="background"?"background":"foreground",workspaceId});
  const documentEngine=new DocumentEngine(orchestrator.workspaces);
  const spreadsheetEngine=new SpreadsheetEngine(orchestrator.workspaces);
  const dataAnalysisEngine=new DataAnalysisEngine();
  const databaseQueryEngine=new DatabaseQueryEngine(orchestrator.workspaces);
  const reportEngine=new ReportEngine(orchestrator.workspaces,orchestrator.artifacts);
  const readAnalysisRows=async(i:Record<string,unknown>):Promise<Record<string,unknown>[]>=>{
    const source=object(i.source);
    if(nonEmpty(source.workspaceId)&&nonEmpty(source.path)){
      const range=await spreadsheetEngine.readRange(source.workspaceId,source.path,{
        sheet:typeof source.sheet==="string"?source.sheet:undefined,
        startRow:typeof source.startRow==="number"?source.startRow:undefined,
        endRow:typeof source.endRow==="number"?source.endRow:undefined,
        columns:strings(source.columns).length?strings(source.columns):undefined
      });
      return range.rows;
    }
    if(Array.isArray(i.rows))return i.rows as Record<string,unknown>[];
    throw new Error("DATA_ANALYSIS_SOURCE_REQUIRED");
  };

  define("software_development",schema({objective:{type:"string"},filePath:{type:"string"},instructions:{type:"string"},exactContent:{type:"string"},targetBranch:{type:"string"},targetPr:{type:"integer"},constraints:{type:"array"},executionMode:{type:"string",enum:["foreground","background"]}},["objective","filePath"]),async i=>{
    const directives=[typeof i.targetBranch==="string"?`TARGET_BRANCH=${i.targetBranch}`:null,Number.isInteger(i.targetPr)?`TARGET_PR=${i.targetPr}`:null,typeof i.instructions==="string"?i.instructions:null].filter(Boolean).join("\n");
    return JSON.stringify(await dispatch("software_development",i,{filePath:i.filePath,instructions:directives,exactContent:i.exactContent,neverAutoMerge:true}));
  });
  define("deep_research",schema({objective:{type:"string"},queries:{type:"array"},maxResultsPerQuery:{type:"integer"},constraints:{type:"array"},workspaceId:{type:"string"}},["objective"]),async i=>{
    const workspaceId=typeof i.workspaceId==="string"?i.workspaceId:orchestrator.workspaces.create({name:"Recherche",ownerType:"ADHOC",ownerId:`research-${randomUUID()}`}).id;
    const result=await dispatch("deep_research",i,{queries:i.queries,maxResultsPerQuery:i.maxResultsPerQuery},workspaceId);
    return JSON.stringify({...result,workspaceId,artifacts:orchestrator.artifacts.listByOperation(result.taskId)});
  });
  define("file_management",schema({action:{type:"string",enum:["LIST","READ","WRITE","DELETE"]},workspaceId:{type:"string"},path:{type:"string"},content:{type:"string"},encoding:{type:"string"}},["action","workspaceId"]),async i=>{
    const result=await dispatch("file_management",{...i,objective:`${i.action} workspace file`},{action:i.action,path:i.path,...(i.encoding==="base64"?{contentBase64:i.content}:{text:i.content})},String(i.workspaceId));
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
  define("document_work",schema({
    action:{type:"string",enum:["READ","SEARCH"]},
    workspaceId:{type:"string"},
    path:{type:"string"},
    query:{type:"string"},
    caseSensitive:{type:"boolean"},
    maxResults:{type:"integer"},
    contextChars:{type:"integer"}
  },["action","workspaceId","path"]),async i=>{
    const workspaceId=String(i.workspaceId),path=String(i.path);
    const doc=await documentEngine.readDocument(workspaceId,path);
    if(i.action==="SEARCH"){
      if(!nonEmpty(i.query))throw new Error("DOCUMENT_QUERY_REQUIRED");
      const matches=documentEngine.searchDocument(doc,{
        query:i.query,
        caseSensitive:i.caseSensitive===true,
        maxResults:typeof i.maxResults==="number"?i.maxResults:undefined,
        contextChars:typeof i.contextChars==="number"?i.contextChars:undefined
      });
      return JSON.stringify({documentId:doc.documentId,workspaceId,path:doc.path,format:doc.format,query:i.query,matchCount:matches.length,matches});
    }
    const sections=(doc.sections??[]).slice(0,20).map(s=>({...s,text:s.text.length>1000?`${s.text.slice(0,1000)}…`:s.text}));
    return JSON.stringify({documentId:doc.documentId,workspaceId:doc.workspaceId,path:doc.path,format:doc.format,sizeBytes:doc.sizeBytes,pageCount:doc.pageCount,title:doc.title,truncated:doc.truncated,warnings:doc.warnings,sectionCount:doc.sections?.length??0,sections,textPreview:(doc.text??"").slice(0,4000)});
  });

  define("spreadsheet_work",schema({
    action:{type:"string",enum:["INSPECT","LIST_SHEETS","READ_RANGE","QUERY"]},
    workspaceId:{type:"string"},
    path:{type:"string"},
    sheet:{type:"string"},
    startRow:{type:"integer"},
    endRow:{type:"integer"},
    columns:{type:"array",items:{type:"string"}},
    filters:{type:"array",items:{type:"object",properties:{column:{type:"string"},operator:{type:"string",enum:["equals","notEquals","contains","startsWith","endsWith","greaterThan","greaterOrEqual","lessThan","lessOrEqual","isEmpty","isNotEmpty"]},value:{}},required:["column","operator"]}},
    sort:{type:"array",items:{type:"object",properties:{column:{type:"string"},direction:{type:"string",enum:["ASC","DESC"]}},required:["column","direction"]}},
    aggregate:{type:"object",properties:{function:{type:"string",enum:["COUNT","SUM","MEAN","MIN","MAX"]},valueColumn:{type:"string"},groupBy:{type:"string"}},required:["function"]}
  },["action","workspaceId","path"]),async i=>{
    const workspaceId=String(i.workspaceId),path=String(i.path);
    if(i.action==="INSPECT")return JSON.stringify(await spreadsheetEngine.inspect(workspaceId,path));
    if(i.action==="LIST_SHEETS")return JSON.stringify(await spreadsheetEngine.listSheets(workspaceId,path));

    const range=await spreadsheetEngine.readRange(workspaceId,path,{
      sheet:typeof i.sheet==="string"?i.sheet:undefined,
      startRow:typeof i.startRow==="number"?i.startRow:undefined,
      endRow:typeof i.endRow==="number"?i.endRow:undefined,
      columns:strings(i.columns).length?strings(i.columns):undefined
    });
    if(i.action==="READ_RANGE")return JSON.stringify(range);

    let rows=range.rows;
    const filters=Array.isArray(i.filters)?i.filters as FilterCondition[]:[];
    if(filters.length)rows=spreadsheetEngine.filter(rows,filters);
    const sortConds=Array.isArray(i.sort)?i.sort as SortCondition[]:[];
    if(sortConds.length)rows=spreadsheetEngine.sort(rows,sortConds);

    if(i.aggregate&&typeof i.aggregate==="object"){
      const aggregateOptions=i.aggregate as AggregateOptions;
      const result=spreadsheetEngine.aggregate(rows,aggregateOptions);
      return JSON.stringify({sheet:range.sheet,columns:range.columns,matchedRows:rows.length,totalRows:range.totalRows,totalRowsKnown:range.totalRowsKnown,truncated:range.truncated,warnings:range.warnings,result});
    }
    return JSON.stringify({sheet:range.sheet,columns:range.columns,rows,totalRows:range.totalRows,totalRowsKnown:range.totalRowsKnown,truncated:range.truncated,warnings:range.warnings});
  });

  define("data_analysis",schema({
    action:{type:"string",enum:["DESCRIBE","COUNT","SUM","MEAN","MEDIAN","MIN","MAX","STDDEV","GROUP_BY","TOP_N","BOTTOM_N","DISTRIBUTION","MISSING_VALUES","DUPLICATES","OUTLIERS","CORRELATION","TIME_SERIES"]},
    rows:{type:"array",items:{type:"object"}},
    source:{type:"object",properties:{workspaceId:{type:"string"},path:{type:"string"},sheet:{type:"string"},startRow:{type:"integer"},endRow:{type:"integer"},columns:{type:"array",items:{type:"string"}}},required:["workspaceId","path"]},
    column:{type:"string"},
    columnA:{type:"string"},
    columnB:{type:"string"},
    groupColumn:{type:"string"},
    valueColumn:{type:"string"},
    fn:{type:"string",enum:["COUNT","SUM","MEAN","MIN","MAX"]},
    n:{type:"integer"},
    dateColumn:{type:"string"},
    granularity:{type:"string",enum:["DAY","WEEK","MONTH","YEAR"]},
    keyColumns:{type:"array",items:{type:"string"}},
    countMode:{type:"string",enum:["COUNT_ROWS","COUNT_NON_NULL"]}
  },["action"]),async i=>{
    const rows=await readAnalysisRows(i);
    switch(i.action){
      case"DESCRIBE":return JSON.stringify(dataAnalysisEngine.describe(rows));
      case"COUNT":return JSON.stringify({result:dataAnalysisEngine.count(rows,(i.countMode as "COUNT_ROWS"|"COUNT_NON_NULL")??"COUNT_ROWS",typeof i.column==="string"?i.column:undefined)});
      case"SUM":return JSON.stringify({result:dataAnalysisEngine.sum(rows,String(i.column))});
      case"MEAN":return JSON.stringify({result:dataAnalysisEngine.mean(rows,String(i.column))});
      case"MEDIAN":return JSON.stringify({result:dataAnalysisEngine.median(rows,String(i.column))});
      case"MIN":return JSON.stringify({result:dataAnalysisEngine.min(rows,String(i.column))});
      case"MAX":return JSON.stringify({result:dataAnalysisEngine.max(rows,String(i.column))});
      case"STDDEV":return JSON.stringify({result:dataAnalysisEngine.stddev(rows,String(i.column))});
      case"GROUP_BY":return JSON.stringify(dataAnalysisEngine.groupBy(rows,String(i.groupColumn),typeof i.valueColumn==="string"?i.valueColumn:undefined,(i.fn as "COUNT"|"SUM"|"MEAN"|"MIN"|"MAX")??"COUNT"));
      case"TOP_N":return JSON.stringify(dataAnalysisEngine.topN(rows,String(i.column),typeof i.n==="number"?i.n:undefined));
      case"BOTTOM_N":return JSON.stringify(dataAnalysisEngine.bottomN(rows,String(i.column),typeof i.n==="number"?i.n:undefined));
      case"DISTRIBUTION":return JSON.stringify(dataAnalysisEngine.distribution(rows,String(i.column)));
      case"MISSING_VALUES":return JSON.stringify(dataAnalysisEngine.missingValues(rows));
      case"DUPLICATES":return JSON.stringify(dataAnalysisEngine.duplicates(rows,strings(i.keyColumns).length?strings(i.keyColumns):undefined));
      case"OUTLIERS":return JSON.stringify(dataAnalysisEngine.outliers(rows,String(i.column)));
      case"CORRELATION":return JSON.stringify(dataAnalysisEngine.correlation(rows,String(i.columnA),String(i.columnB)));
      case"TIME_SERIES":return JSON.stringify(dataAnalysisEngine.timeSeriesSummary(rows,String(i.dateColumn),(i.granularity as "DAY"|"WEEK"|"MONTH"|"YEAR")??"DAY",typeof i.valueColumn==="string"?i.valueColumn:undefined));
      default:throw new Error("INVALID_DATA_ANALYSIS_ACTION");
    }
  });

  define("database_query",schema({
    action:{type:"string",enum:["LIST_TABLES","DESCRIBE_TABLE","SELECT"]},
    workspaceId:{type:"string"},
    path:{type:"string"},
    tableName:{type:"string"},
    sql:{type:"string"}
  },["action","workspaceId","path"]),async i=>{
    const workspaceId=String(i.workspaceId),path=String(i.path);
    switch(i.action){
      case"LIST_TABLES":return JSON.stringify(databaseQueryEngine.listTables(workspaceId,path));
      case"DESCRIBE_TABLE":if(!nonEmpty(i.tableName))throw new Error("DATABASE_TABLE_NAME_REQUIRED");return JSON.stringify(databaseQueryEngine.describeTable(workspaceId,path,i.tableName));
      case"SELECT":if(!nonEmpty(i.sql))throw new Error("DATABASE_SQL_REQUIRED");return JSON.stringify(databaseQueryEngine.select(workspaceId,path,i.sql));
      default:throw new Error("INVALID_DATABASE_ACTION");
    }
  });

  define("report_generation",schema({
    workspaceId:{type:"string"},
    title:{type:"string"},
    summary:{type:"string"},
    format:{type:"string",enum:["markdown","json","csv"]},
    sections:{type:"array",items:{type:"object",properties:{title:{type:"string"},content:{type:"string"},provenance:{type:"array",items:{type:"object",properties:{workspaceId:{type:"string"},path:{type:"string"},page:{type:"integer"},sheet:{type:"string"},columns:{type:"array",items:{type:"string"}},query:{type:"string"}},required:["workspaceId","path"]}}},required:["title","content"]}},
    tables:{type:"array",items:{type:"object",properties:{title:{type:"string"},columns:{type:"array",items:{type:"string"}},rows:{type:"array",items:{type:"array",items:{}}}},required:["title","columns","rows"]}},
    findings:{type:"array",items:{type:"object",properties:{severity:{type:"string",enum:["LOW","MEDIUM","HIGH","CRITICAL","INFO"]},title:{type:"string"},evidence:{type:"string"},recommendation:{type:"string"}},required:["title"]}},
    sources:{type:"array",items:{type:"object",properties:{workspaceId:{type:"string"},path:{type:"string"}},required:["workspaceId","path"]}},
    persistArtifact:{type:"boolean"},
    targetPath:{type:"string"}
  },["workspaceId","title","summary"]),async i=>{
    const workspaceId=String(i.workspaceId);
    const sectionsIn=Array.isArray(i.sections)?i.sections as ReportSection[]:[];
    const tablesIn=Array.isArray(i.tables)?i.tables as {title:string;columns:string[];rows:(string|number|boolean|null)[][]}[]:[];
    const findingsIn=Array.isArray(i.findings)?i.findings as Finding[]:[];
    const sourcesIn=Array.isArray(i.sources)?i.sources as Provenance[]:[];

    const structure={
      title:String(i.title),
      summary:String(i.summary),
      sections:sectionsIn.slice(0,WORKBENCH_REPORT_LIMITS.maxSections),
      tables:tablesIn.slice(0,WORKBENCH_REPORT_LIMITS.maxTables).map(t=>({...t,rows:(t.rows??[]).slice(0,WORKBENCH_REPORT_LIMITS.maxTableRows)})),
      findings:findingsIn.slice(0,WORKBENCH_REPORT_LIMITS.maxFindings),
      sources:sourcesIn.slice(0,WORKBENCH_REPORT_LIMITS.maxSources)
    };
    const format=(i.format as "markdown"|"json"|"csv")??"markdown";
    const result=reportEngine.generateReport(workspaceId,structure,format,{
      persistArtifact:i.persistArtifact===true||nonEmpty(i.targetPath),
      targetPath:typeof i.targetPath==="string"?i.targetPath:undefined
    });
    return JSON.stringify(result);
  });

  if(config.webSearch.provider==="none"){const web=base.get("web_search")!;web.availability="UNAVAILABLE";web.unavailableReason="Web provider is not configured";delete web.handler;}
  for(const s of base.values())if(s.serviceCapability&&!orchestrator.registry.findServiceForCapability(s.serviceCapability)){s.availability="UNAVAILABLE";s.unavailableReason=`Service unavailable: ${s.serviceCapability}`;delete s.handler;}
  return [...base.values()];
}
