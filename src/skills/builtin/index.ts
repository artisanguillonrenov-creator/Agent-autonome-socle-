import type { SkillDefinition } from "../../types.js";
import { getCurrentTimeSkill } from "./getCurrentTime.js";
import { rememberFactSkill } from "./rememberFact.js";

export const builtinSkills: SkillDefinition[] = [getCurrentTimeSkill, rememberFactSkill];
