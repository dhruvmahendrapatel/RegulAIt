#!/bin/bash
# ADR-0343 failover suite: become a synchronous standby (application_name standby1) of pg-primary, then run Postgres.
set -euo pipefail
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  until pg_isready -h pg-primary -U regulait; do sleep 1; done
  gosu postgres pg_basebackup \
    -d "host=pg-primary port=5432 user=regulait password=${PGPASSWORD} application_name=standby1" \
    -D "$PGDATA" -R -X stream -c fast
  # once promoted it has no standby of its own, so it must not wait for one
  echo "synchronous_standby_names = ''" >> "$PGDATA/postgresql.auto.conf"
fi
exec gosu postgres postgres -D "$PGDATA"
