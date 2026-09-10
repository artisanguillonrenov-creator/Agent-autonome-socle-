/**
 * Les quatre bureaux métier (Chantier 9) gèrent un état structuré PAR PROJET (analyses
 * produit, identité artistique, CRM, stratégie marketing) — une donnée fondamentalement
 * différente de la mémoire conversationnelle (facts/souvenirs vectoriels) que régit
 * `projects.projectIsolation`. Cet état reste donc TOUJOURS strictement scopé par
 * workspace, quelle que soit la valeur de ce réglage : il n'existe aucun scénario légitime
 * où l'identité visuelle ou le pipeline commercial d'un projet devrait se mélanger avec
 * celui d'un autre. `GLOBAL_BUREAU_SCOPE` n'est qu'un panier partagé pour les missions
 * ad-hoc sans projet actif — jamais un mélange de plusieurs projets distincts.
 */
export const GLOBAL_BUREAU_SCOPE = "__global__";

export function bureauScope(workspaceId?: string): string {
  return workspaceId && workspaceId.trim() ? workspaceId.trim() : GLOBAL_BUREAU_SCOPE;
}
