/**
 * Édition ciblée d'un fichier (str-replace) — alternative au remplacement complet
 * du fichier par le LLM (`SoftwareFactoryService.generateCodeUpdate`), tâche 5 du
 * brief JARVIS-00 (gap `surgical_edit` de `gapAnalysis.ts`, cause probable de la
 * boucle de patches répétés observée PR #22-#27 : régénérer un fichier entier à
 * chaque tentative dérive plus facilement qu'une édition ciblée).
 *
 * Fonction pure, sans dépendance GitHub. `executeWorkflow` traite son résultat
 * exactement comme n'importe quel autre `updatedCode` (contenu complet du fichier
 * après édition) : le secret guard et le contrôle de fidélité continuent de
 * scanner le fichier entier résultant, jamais un diff calculé localement — c'est
 * ce choix qui préserve sans adaptation l'invariant du secret guard documenté
 * dans `executeWorkflow` ("updatedCode couvre aussi le diff... donc tout secret
 * introduit par le diff est nécessairement présent dans updatedCode").
 */

export interface SurgicalEditRequest {
  oldString: string;
  newString: string;
}

export class SurgicalEditError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SurgicalEditError";
    this.code = code;
  }
}

/** Remplace une occurrence unique de `oldString` par `newString` — jamais un remplacement ambigu ou silencieusement partiel. */
export function applySurgicalEdit(originalContent: string, edit: SurgicalEditRequest): string {
  if (!edit.oldString) {
    throw new SurgicalEditError("SURGICAL_EDIT_OLD_STRING_REQUIRED", "oldString est obligatoire et ne peut pas être vide.");
  }
  if (edit.oldString === edit.newString) {
    throw new SurgicalEditError("SURGICAL_EDIT_NO_OP", "oldString et newString sont identiques : aucune modification à appliquer.");
  }
  const occurrences = originalContent.split(edit.oldString).length - 1;
  if (occurrences === 0) {
    throw new SurgicalEditError("SURGICAL_EDIT_OLD_STRING_NOT_FOUND", "oldString est introuvable dans le contenu actuel du fichier.");
  }
  if (occurrences > 1) {
    throw new SurgicalEditError("SURGICAL_EDIT_OLD_STRING_NOT_UNIQUE", `oldString apparaît ${occurrences} fois dans le fichier : fournir un extrait plus long incluant du contexte qui le rend unique.`);
  }
  return originalContent.replace(edit.oldString, edit.newString);
}
