# Vague 10A : image Docker sécurisée multi-étapes pour Jarvis (Node.js + TypeScript).
# syntax=docker/dockerfile:1

# --- Étape 1 : build --------------------------------------------------------
# Compile le TypeScript (src/ -> dist/) avec toutes les dépendances (dev incluses),
# nécessaires uniquement à la compilation — jamais embarquées dans l'image finale.
FROM node:22-alpine AS builder
WORKDIR /app
# better-sqlite3/dockerode nécessitent une compilation native si aucun binaire prébuilt
# n'est disponible pour musl/alpine.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY www ./www
RUN npm run build

# --- Étape 2 : dépendances de production uniquement -------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --omit=dev --no-audit --no-fund

# --- Étape 3 : image de production ------------------------------------------
# Image légère et sécurisée : uniquement le code compilé + dépendances de production.
FROM node:22-alpine AS runtime
# tini : reap correct des processus enfants (PID 1) ; postgresql-client : pg_isready
# (voir docker-entrypoint.sh, Vague 10D).
RUN apk add --no-cache tini postgresql-client
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/www ./www
COPY package.json ./
COPY config ./config
COPY docker-entrypoint.sh ./docker-entrypoint.sh

# Volume de travail cloisonné dédié à la sandbox Software Factory (Vague 10C) — jamais le
# code source applicatif ni le .env, qui ne sont jamais copiés dedans (voir
# src/execution/dockerSandbox.ts).
RUN mkdir -p data /tmp/jarvis-sandbox \
  && chmod +x docker-entrypoint.sh \
  && chown -R node:node /app /tmp/jarvis-sandbox

# Sécurité renforcée (Vague 10A) : exécution sous un utilisateur non-root — un processus
# Jarvis compromis n'obtient jamais les privilèges de la machine hôte.
USER node

# HTTP (chat/API) + WebSocket (streaming audio, Vague 9) partagent le même port HTTP :
# WebSocketServer est attaché au serveur http.Server existant (voir src/index.ts).
EXPOSE 3000

ENTRYPOINT ["tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
