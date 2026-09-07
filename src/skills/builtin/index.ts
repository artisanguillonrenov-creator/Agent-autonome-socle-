import type { SkillDefinition } from "../../types.js";
import { getCurrentTimeSkill } from "./getCurrentTime.js";
import { rememberFactSkill } from "./rememberFact.js";
import { createTaskSkill, listTasksSkill, completeTaskSkill } from "./tasks.js";
import { webSearchSkill } from "./webSearch.js";
import { executeCodeSkill } from "./executeCode.js";
import { dispatchCapabilitySkill } from "./dispatchCapability.js";

export const builtinSkills: SkillDefinition[] = [
  getCurrentTimeSkill,
  rememberFactSkill,
  createTaskSkill,
  listTasksSkill,
  completeTaskSkill,
  webSearchSkill,
  executeCodeSkill,
  dispatchCapabilitySkill,
];
