import type { SkillDefinition } from "../../types.js";
import { getCurrentTimeSkill } from "./getCurrentTime.js";
import { rememberFactSkill } from "./rememberFact.js";
import { createTaskSkill, listTasksSkill, completeTaskSkill } from "./tasks.js";
import { webSearchSkill } from "./webSearch.js";
import { executeCodeSkill } from "./executeCode.js";
import { dispatchCapabilitySkill } from "./dispatchCapability.js";
import { executeMissionSkill } from "./executeMission.js";
import { productStudioSkill } from "./productStudio.js";
import { creativeStudioSkill } from "./creativeStudio.js";
import { commercialOfficeSkill } from "./commercialOffice.js";
import { marketingOfficeSkill } from "./marketingOffice.js";

export const builtinSkills: SkillDefinition[] = [
  getCurrentTimeSkill,
  rememberFactSkill,
  createTaskSkill,
  listTasksSkill,
  completeTaskSkill,
  webSearchSkill,
  executeCodeSkill,
  dispatchCapabilitySkill,
  executeMissionSkill,
  productStudioSkill,
  creativeStudioSkill,
  commercialOfficeSkill,
  marketingOfficeSkill,
];
