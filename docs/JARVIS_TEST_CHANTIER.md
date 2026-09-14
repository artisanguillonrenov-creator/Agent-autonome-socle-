# Chantier de Test du Pipeline Jarvis

## Objectif
Valider le bon fonctionnement du pipeline Jarvis en conditions réelles sans impacter la branche `main`.

## Procédure de test

1. **Création de la branche dédiée**
   - Créez une nouvelle branche à partir de `main` (ou de la branche de développement en cours).
   - Exemple : `feat/test-pipeline-jarvis`

2. **Déclenchement du pipeline**
   - Effectuez des modifications mineures (ex : ajout d'un fichier vide ou d'un commentaire) pour déclencher le pipeline CI/CD.
   - Ou créez une Pull Request (PR) vers la branche principale pour valider l'intégration.

3. **Vérification des résultats**
   - Assurez-vous que tous les tests unitaires passent avec succès.
   - Vérifiez que le linting et le build ne génèrent aucune erreur.
   - Confirmez que les artefacts sont correctement générés.

4. **Validation manuelle (si nécessaire)**
   - Déployez l'environnement de test pour vérifier le comportement runtime.
   - Vérifiez les logs et les métriques de performance.

## Points de vérification
- [ ] Les tests unitaires sont tous valides.
- [ ] La build est propre (pas d'erreurs ni d'avertissements critiques).
- [ ] Le pipeline prend moins de X minutes (définir le seuil).

## Risques
- Aucun impact sur les environnements de production ou de développement critiques.
- Les erreurs détectées doivent être signalées via le système de ticketing en place.