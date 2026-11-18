#!/bin/bash
# ADR-0343 failover suite: let the standby stream from the primary (the suite's private network only).
set -euo pipefail
echo "host replication regulait all scram-sha-256" >> "$PGDATA/pg_hba.conf"
