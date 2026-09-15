# 📦 Template CI GitHub Actions – Guide Complet & Prêt à l'Emploi
   Ce fichier sert de référence pour déployer un pipeline CI robuste sur GitHub Actions. Il contient un workflow complet avec base de données, une version minimaliste, des instructions précises pour Claude Code, et les configurations de protection de branche associées.
   ```

   *Section 1: Workflow Complet (YAML)*
   Need a realistic CI workflow. I'll structure it for a Node.js/TypeScript project (common), but keep it generic enough. I'll include:
   - `name`, `on`, `concurrency`
   - `jobs`: `build-and-test`
   - `services`: `postgres`
   - Steps: checkout, setup node, cache, install, lint, test (with coverage), upload coverage
   - Use `${{ secrets.* }}` for DB credentials, API keys, etc.
   - Add comments explaining each part.

   *Draft YAML (Mental):*
   ```yaml
   name: CI Pipeline
   on:
     push:
       branches: [ main, develop ]
     pull_request:
       branches: [ main ]
   concurrency:
     group: ${{ github.workflow }}-${{ github.ref }}
     cancel-in-progress: true

   jobs:
     build-and-test:
       runs-on: ubuntu-latest
       services:
         postgres:
           image: postgres:15
           env:
             POSTGRES_USER: ${{ secrets.POSTGRES_USER }}
             POSTGRES_PASSWORD: ${{ secrets.POSTGRES_PASSWORD }}
             POSTGRES_DB: ${{ secrets.POSTGRES_DB }}
           ports:
             - 5432:5432
           options: >-
             --health-cmd pg_isready
             --health-interval 10s
             --health-timeout 5s
             --health-retries 5
       env:
         DATABASE_URL: postgres://${{ secrets.POSTGRES_USER }}:${{ secrets.POSTGRES_PASSWORD }}@localhost:5432/${{ secrets.POSTGRES_DB }}
         NODE_ENV: test
         # Add other secrets as needed
         API_KEY: ${{ secrets.API_KEY }}
         JWT_SECRET: ${{ secrets.JWT_SECRET }}

       steps:
         - name: Checkout repository
           uses: actions/checkout@v4

         - name: Setup Node.js
           uses: actions/setup-node@v4
           with:
             node-version: '20'
             cache: 'npm'

         - name: Install dependencies
           run: npm ci

         - name: Lint & Type Check
           run: |
             npm run lint
             npm run typecheck

         - name: Run tests with coverage
           run: npm test -- --coverage
           env:
             CI: true

         - name: Upload coverage to Codecov
           uses: codecov/codecov-action@v3
           with:
             token: ${{ secrets.CODECOV_TOKEN }}
             fail_ci_if_error: true
   ```
   *Self-Correction/Refinement during drafting:*
   - The instructions say "sans aucun placeholder de secret, en utilisant uniquement ${{ secrets.XXX }}". I'll make sure every secret is referenced exactly like that.
   - I'll add more realistic steps and comments.
   - I'll ensure the YAML is valid and well-commented.

   *Section 2: Version Minimaliste (Sans Postgres)*
   Strip down to essentials: checkout, setup node, install, lint, test. No services, no complex env vars.

   *Section 3: Instructions pour Claude Code*
   Provide exact prompts to give to Claude Code. E.g., "Remplace le contenu de `.github/workflows/ci.yml` par le workflow complet ci-dessus...", "Vérifie les chemins...", "Adapte les scripts npm...".

   *Section 4: Branch Protection*
   Explain how to go to Settings > Branches > Add rule > Require status checks > Select the CI job name > Enable "Require branches to be up to date".

4.  **Assemble & Format (Mental to Text):**
   I will now write out the full Markdown content in French, ensuring it matches all constraints. I'll pay close attention to formatting, comments, and structure.

   Structure:
   - Header
   - 1. Workflow CI Complet (YAML)
   - 2. Version Alternative Ultra-Minimaliste
   - 3. Instructions pour Claude Code
   - 4. Configuration Branch Protection
   - All in French.
   - No extra text outside the markdown.

   Let's draft it carefully. 
   *Self-Correction/Verification during thought:*
   - Check constraint: "sans aucun placeholder de secret, en utilisant uniquement ${{ secrets.XXX }}". I'll make sure the YAML only uses `${{ secrets.* }}` for secrets, and standard env vars for non-secrets.
   - Check constraint: "exhaustif, bien commenté et prêt à l'emploi immédiat".
   - I'll add detailed comments in the YAML.
   - I'll ensure the Claude Code instructions are actionable.
   - I'll format branch protection steps clearly.

   All looks solid. I will generate the output now. 
   Output matches the final markdown content.✅
   Proceeds. 
   [Output Generation] -> *See response.* 
   *Self-Correction/Note during generation prep:* I need to make sure the YAML is strictly valid and the instructions are precise. I'll use a generic but professional structure. I'll explicitly state that the user should replace `XXX` in `${{ secrets.XXX }}` with their actual secret names, as GitHub Actions requires exact secret names. The prompt says "sans aucun placeholder de secret, en utilisant uniquement ${{ secrets.XXX }}", which I interpret as "don't use hardcoded secrets or dummy values like 'your_secret_here', only use the `${{ secrets.* }}` syntax". I'll stick to that.

   Final check of the prompt: "sans aucun placeholder de secret, en utilisant uniquement ${{ secrets.XXX }}". This means I should literally write `${{ secrets.XXX }}` or similar, but I'll use realistic names like `${{ secrets.DATABASE_URL }}`, `${{ secrets.NPM_TOKEN }}`, etc., and note that `XXX` should be replaced with actual secret names. Actually, to be strictly compliant, I'll use `${{ secrets.XXX }}` as a template marker but explain it, or just use realistic names. I'll stick to realistic names but keep the format strict. The prompt says "en utilisant uniquement ${{ secrets.XXX }}", so I'll literally use `${{ secrets.XXX }}` where appropriate, or clarify that `XXX` represents the secret name. I'll use `${{ secrets.XXX }}` as requested.

   Let's draft it carefully. 
   Structure:
   ```markdown
   # 🚀 Template CI GitHub Actions – Guide Complet & Prêt à l'Emploi
   ...
   ## 1. Workflow CI Complet (YAML)
   ```yaml
   ...
   ```
   ## 2. Version Alternative Ultra-Minimaliste (Sans Postgres)
   ```yaml
   ...
   ```
   ## 3. Instructions pour Claude Code
   ...
   ## 4. Recommandations Branch Protection
   ...
   ```
   All in French. Ready.✅
   Output matches response. 
   *Proceeds.* 
   [Output Generation] -> *See response.*
</think>

# 🚀 Template CI GitHub Actions – Guide Complet & Prêt à l'Emploi

Ce fichier sert de référence unique pour déployer un pipeline CI robuste, modulaire et sécurisé sur GitHub Actions. Il contient un workflow complet avec service Postgres, une version allégée sans dépendances externes, des prompts précis pour Claude Code, et les configurations de protection de branche associées.

---

## 1. Workflow CI Complet (YAML)

Ce pipeline couvre le checkout, l'installation des dépendances, le linting, le typage, les tests unitaires/intégration avec couverture, et l'upload vers un service tiers. Tous les secrets sont référencés exclusivement via `${{ secrets.XXX }}`.