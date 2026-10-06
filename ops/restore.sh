#!/bin/sh
#
# Stringline restore.
#
# A backup nobody has restored is a hope, not a backup — so this exists to be
# run on a normal day, against a scratch database, to prove the dumps are
# worth what we think they are.
#
# Usage:
#   ops/restore.sh                         # newest dump -> scratch db, compare counts
#   ops/restore.sh <dump>                  # a specific dump -> scratch db
#   ops/restore.sh <dump> --into NAME      # somewhere else
#   ops/restore.sh <dump> --into stringline --yes-overwrite-production
#
# The default target is a throwaway. Restoring over the live database needs
# that second flag spelled out in full, because a restore script that defaults
# to clobbering production is a loaded gun left on the table.

set -eu

DOCKER=/volume1/@appstore/ContainerManager/usr/bin/docker
ROOT=/volume1/docker/stringline-backups
DB_CONTAINER=stringline-db
PGUSER=stringline
PRODUCTION=stringline

TARGET=stringline_restoretest
DUMP=
OVERWRITE=no

while [ $# -gt 0 ]; do
    case $1 in
        --into) TARGET=$2; shift 2 ;;
        --yes-overwrite-production) OVERWRITE=yes; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) DUMP=$1; shift ;;
    esac
done

if [ -z "$DUMP" ]; then
    DUMP=$(ls -t "$ROOT"/daily/*-db.dump 2>/dev/null | head -1 || true)
    [ -n "$DUMP" ] || { echo "no dumps in $ROOT/daily — has backup.sh ever run?"; exit 1; }
    echo "using the newest dump: $(basename "$DUMP")"
fi
[ -f "$DUMP" ] || { echo "no such dump: $DUMP"; exit 1; }

if [ "$TARGET" = "$PRODUCTION" ] && [ "$OVERWRITE" != yes ]; then
    cat >&2 <<EOF
Refusing to restore over the live database.

  $TARGET is production. If that is genuinely what you want, say so:
    $0 $DUMP --into $PRODUCTION --yes-overwrite-production

  To just prove the backup works, run with no arguments — it restores into a
  scratch database and compares the row counts against production for you.
EOF
    exit 1
fi

psql() { $DOCKER exec -i "$DB_CONTAINER" psql -U "$PGUSER" -v ON_ERROR_STOP=1 "$@"; }

echo
echo "restoring $(basename "$DUMP") into '$TARGET'"

# Terminate anything connected, or DROP DATABASE fails with "is being accessed
# by other users" — which on a scratch database is never what you meant.
psql -d postgres -q -c \
    "select pg_terminate_backend(pid) from pg_stat_activity
      where datname = '$TARGET' and pid <> pg_backend_pid();" >/dev/null 2>&1 || true

if [ "$TARGET" != "$PRODUCTION" ]; then
    psql -d postgres -q -c "drop database if exists $TARGET;"
    psql -d postgres -q -c "create database $TARGET owner $PGUSER;"
fi

# --clean drops objects first so restoring over an existing database is
# idempotent. Warnings about objects that do not exist yet are expected noise
# on a fresh target, so only real errors are surfaced.
$DOCKER exec -i "$DB_CONTAINER" pg_restore -U "$PGUSER" -d "$TARGET" \
    --no-owner --clean --if-exists < "$DUMP" 2>&1 | grep -v '^$' | grep -vi 'does not exist' || true

echo
echo "comparing against production:"
echo
printf '  %-24s %10s %10s\n' table "$TARGET" "$PRODUCTION"
printf '  %-24s %10s %10s\n' ------------------------ ---------- ----------

# count(*) rather than pg_stat_user_tables, whose n_live_tup is an estimate
# refreshed by autovacuum. An estimate is useless for proving a restore.
TABLES=$(psql -d "$PRODUCTION" -At -c \
    "select tablename from pg_tables where schemaname='public' order by tablename;")

mismatch=0
for t in $TABLES; do
    a=$(psql -d "$TARGET"     -At -c "select count(*) from \"$t\";" 2>/dev/null || echo ERR)
    b=$(psql -d "$PRODUCTION" -At -c "select count(*) from \"$t\";" 2>/dev/null || echo ERR)
    flag=
    [ "$a" = "$b" ] || { flag='  <-- differs'; mismatch=$((mismatch + 1)); }
    printf '  %-24s %10s %10s%s\n' "$t" "$a" "$b" "$flag"
done

echo
if [ "$mismatch" -eq 0 ]; then
    echo "every table matches. The backup restores cleanly."
else
    # Expected when the dump predates recent writes — the dump is a snapshot,
    # production has moved on. Worth reading, not automatically a failure.
    echo "$mismatch table(s) differ. If the dump is older than the last few"
    echo "edits that is exactly right; if it is today's, investigate."
fi

if [ "$TARGET" != "$PRODUCTION" ]; then
    echo
    echo "scratch database '$TARGET' left in place for inspection. Remove with:"
    echo "  $DOCKER exec -i $DB_CONTAINER psql -U $PGUSER -d postgres -c 'drop database $TARGET;'"
fi
