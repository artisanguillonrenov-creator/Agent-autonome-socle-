export type SettingsLevel="SIMPLE"|"ADVANCED"|"EXPERT";
export type SettingsSource="DEFAULT"|"DATABASE"|"ENVIRONMENT"|"SYSTEM";
export type SettingsAvailability="AVAILABLE"|"FUTURE"|"SYSTEM_LOCKED";
export type SettingsSection="GENERAL"|"INTELLIGENCE"|"AUTONOMY_SECURITY"|"CONNECTIONS_SERVICES"|"PROJECTS_MEMORY"|"SKILLS_WORKFLOWS"|"AUTOMATIONS"|"ACTIVITY"|"SYSTEM";
export interface SettingsDefinition {key:string;section:SettingsSection;label:string;description:string;type:"boolean"|"string"|"number"|"enum"|"status"|"action";level:SettingsLevel;defaultValue:unknown;editable:boolean;availability:SettingsAvailability;requiresRestart:boolean;validation?:{enum?:unknown[];min?:number;max?:number};unavailableReason?:string;plannedChantier?:number}

const available=(key:string,label:string,type:SettingsDefinition["type"],defaultValue:unknown,validation?:SettingsDefinition["validation"]):SettingsDefinition=>({key,section:"GENERAL",label,description:label,type,level:"SIMPLE",defaultValue,editable:true,availability:"AVAILABLE",requiresRestart:false,validation});
const future=(key:string,section:SettingsSection,label:string,plannedChantier:number,level:SettingsLevel="ADVANCED"):SettingsDefinition=>({key,section,label,description:`${label} sera raccordé à son moteur autoritaire dans un prochain chantier.`,type:"status",level,defaultValue:null,editable:false,availability:"FUTURE",unavailableReason:"Fonction non raccordée en V1",plannedChantier,requiresRestart:false});

export const SettingsCatalog:readonly SettingsDefinition[]=[
 available("settings.interfaceMode","Mode d’interface","enum","SIMPLE",{enum:["SIMPLE","ADVANCED","EXPERT"]}),
 available("settings.startupView","Vue au démarrage","enum","CHAT",{enum:["CHAT","COMMAND_CENTER","LAST_VIEW"]}),
 available("settings.timelineMode","Mode timeline","enum","AUTO",{enum:["AUTO","ALWAYS","COMPACT"]}),
 available("settings.expandCompletedMissions","Déplier les missions terminées","boolean",false),
 available("settings.theme","Thème","enum","SYSTEM",{enum:["SYSTEM","LIGHT","DARK"]}),
 future("settings.language","GENERAL","Langue",9),future("settings.responseLength","GENERAL","Longueur des réponses",9),future("settings.automaticVoiceReading","GENERAL","Lecture vocale automatique",10),
 ...["temperature","topP","maxOutput","contextWindowOverride","fallbackModel1","fallbackModel2","visionModel","codingModel","researchModel","utilityModel","localModelPriority","toolCompatibilityTest"].map(k=>future(`intelligence.${k}`,"INTELLIGENCE",k, k.includes("fallback")||k.includes("Model")?10:8,"EXPERT")),
 future("security.permissionMatrix","AUTONOMY_SECURITY","Matrice READ / WRITE / DELETE / EXECUTE / SEND / PURCHASE / COMPUTER_CONTROL",10,"EXPERT"),
 ...[["restGeneric",8],["mcp",8],["oauthConnector",9],["database",8],["browser",10],["computer",10],["agentToAgent",10],["webhook",9]].map(([k,c])=>future(`connections.${k}`,"CONNECTIONS_SERVICES",String(k),Number(c),"EXPERT")),
 ...["projectIsolation","projectRepository","projectModelPreset","projectServices","projectSecrets","knowledgeRag","vectorDb","autoIndexing","memoryRetention","semanticRetrieval","topK"].map(k=>future(`projects.${k}`,"PROJECTS_MEMORY",k,8)),
 future("agents.businessStudios","SKILLS_WORKFLOWS","Creative, Product, Commercial et Marketing studios",9),
 future("automations.externalTriggers","AUTOMATIONS","Déclencheurs e-mail, CRM et externes",9),
 future("notifications.push","ACTIVITY","Notifications Android, e-mail, SMS et voix",9),
];
