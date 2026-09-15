#!/bin/sh
# Vague 10D : script d'entrée sécurisé — attend que PostgreSQL soit réellement prêt
# (pg_isready) avant de démarrer la boucle agent, pour une résilience totale lors des
# redémarrages automatiques de conteneurs (dépendance jarvis-db qui n'a pas encore fini son
# propre démarrage, redéploiement, etc.). Sans DATABASE_URL configuré, l'agent retombe sur
# SQLite et cette attente est simplement ignorée.
set -eu

if [ -n "${DATABASE_URL:-}" ]; then
  # postgres://user:pass@host:port/db -> host, port (défaut 5432 si absent de l'URL).
  PG_HOST=$(echo "$DATABASE_URL" | sed -E 's#^[a-zA-Z0-9+]+://[^@]*@([^:/?]+).*#\1#')
  PG_PORT=$(echo "$DATABASE_URL" | sed -E 's#^[a-zA-Z0-9+]+://[^@]*@[^:/?]+:?([0-9]*).*#\1#')
  PG_PORT=${PG_PORT:-5432}

  echo "[entrypoint] En attente de PostgreSQL sur ${PG_HOST}:${PG_PORT}..."
  attempts=30
  until pg_isready -h "$PG_HOST" -p "$PG_PORT" -q 2>/dev/null; do
    attempts=$((attempts - 1))
    if [ "$attempts" -le 0 ]; then
      echo "[entrypoint] PostgreSQL toujours injoignable après plusieurs tentatives — démarrage quand même (le pool applicatif réessaiera)." >&2
      break
    fi
    echo "[entrypoint] PostgreSQL pas encore prêt (${attempts} tentative(s) restante(s))..."
    sleep 2
  done
  if [ "$attempts" -gt 0 ]; then
    echo "[entrypoint] PostgreSQL est prêt."
  fi
fi

exec "$@"
