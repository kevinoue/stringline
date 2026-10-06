#!/bin/sh
#
# Stringline backup — database and uploaded documents.
#
# Runs from DSM Task Scheduler, nightly. Needs no sudo: the Proxima account is
# in the `docker` group, so it can talk to the daemon directly.
#
# Three rules are load-bearing here, each of them the answer to a way backups
# usually fail silently:
#
#   1. Nothing is pruned until the new backup has been verified. A naive script
#      prunes on every run, so a fortnight of failures quietly eats the whole
#      retention window and you discover it the day you need a restore.
#   2. Every artefact is written as `.part` and renamed only once complete, so
#      an interrupted run can never leave a file that looks finished.
#   3. The dump is read back with `pg_restore --list` before it counts. A
#      truncated or corrupt dump is the normal failure, and it looks exactly
#      like a good one until the day you try to use it.
#
# Exits non-zero and writes failure into status.json so the health check has
# something to alarm on. Silence is not success.

set -eu

DOCKER=/volume1/@appstore/ContainerManager/usr/bin/docker

# Deliberately NOT inside /volume1/docker/stringline. That directory is the
# deploy target and gets a source tarball extracted over it; one `rm -rf` to
# redeploy clean would take every backup with it.
ROOT=/volume1/docker/stringline-backups

DB_CONTAINER=stringline-db
API_CONTAINER=stringline-api
PGUSER=stringline
PGDATABASE=stringline

KEEP_DAILY=30
KEEP_WEEKLY=8

STAMP=$(date +%Y%m%d-%H%M%S)
TODAY=$(date +%Y-%m-%d)
DOW=$(date +%u) # 1=Monday .. 7=Sunday

DAILY=$ROOT/daily
WEEKLY=$ROOT/weekly
STATUS=$ROOT/status.json
LOG=$ROOT/backup.log

mkdir -p "$DAILY" "$WEEKLY"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" | tee -a "$LOG"; }

# Written on every exit path, success or failure, so a stale success can never
# outlive a broken backup. The health check reads `ok` and `finished`.
write_status() {
    cat > "$STATUS" <<JSON
{
  "ok": $1,
  "finished": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "stamp": "$STAMP",
  "detail": "$2",
  "db_bytes": ${3:-0},
  "uploads_bytes": ${4:-0},
  "tables": ${5:-0},
  "daily_kept": $(ls -1 "$DAILY"/*.dump 2>/dev/null | wc -l | tr -d ' '),
  "weekly_kept": $(ls -1 "$WEEKLY"/*.dump 2>/dev/null | wc -l | tr -d ' ')
}
JSON
}

# What the script is currently doing, for the failure message. A named stage
# beats $LINENO, which busybox `ash` reports as the trap's own line rather than
# the failing one — it looked precise and was simply wrong.
STAGE=starting

# Any unexpected failure lands here. $? is captured first — `write_status`
# runs commands of its own and would otherwise overwrite it.
on_error() {
    code=$?
    log "FAILED while $STAGE (exit $code) — see above. Nothing was pruned."
    # Half-written artefacts would otherwise accumulate forever: `.part` does
    # not match the retention globs, so nothing would ever clean them up.
    rm -f "$DAILY"/*.part
    write_status false "failed while $STAGE (exit $code)"
    exit $code
}
trap 'on_error' EXIT INT TERM

log "=== backup $STAMP ==="

# ---------------------------------------------------------------- database ---
# -Fc is PostgreSQL's custom format: compressed, and `pg_restore` can list and
# selectively restore from it. No password needed — inside the container the
# local socket trusts the POSTGRES_USER.
DB_PART=$DAILY/$STAMP-db.dump.part
DB_FINAL=$DAILY/$STAMP-db.dump

STAGE="dumping the database"
log "dumping $PGDATABASE"
$DOCKER exec "$DB_CONTAINER" pg_dump -U "$PGUSER" -d "$PGDATABASE" -Fc --no-owner > "$DB_PART"

DB_BYTES=$(wc -c < "$DB_PART" | tr -d ' ')
if [ "$DB_BYTES" -lt 4096 ]; then
    log "dump is only ${DB_BYTES}B — too small to be real"
    exit 1
fi

# The verification that matters. A dump that cannot be listed cannot be
# restored, and this is the only moment we are still in a position to shout.
STAGE="verifying the dump"
TABLES=$($DOCKER exec -i "$DB_CONTAINER" pg_restore --list < "$DB_PART" 2>/dev/null \
         | grep -c 'TABLE DATA' || true)
if [ -z "$TABLES" ] || [ "$TABLES" -lt 5 ]; then
    log "dump lists only ${TABLES:-0} tables — refusing to trust it"
    mkdir -p "$ROOT/failed" && mv "$DB_PART" "$ROOT/failed/$STAMP-db.dump.bad"
    exit 1
fi
log "verified: ${DB_BYTES}B, $TABLES tables with data"

# ----------------------------------------------------------------- uploads ---
# Completion photographs and signed documents. Losing these loses the proof a
# job was done, which is worse than losing a schedule that can be retyped.
UP_PART=$DAILY/$STAMP-uploads.tgz.part
UP_FINAL=$DAILY/$STAMP-uploads.tgz

STAGE="archiving uploads"
log "archiving uploads"
$DOCKER exec "$API_CONTAINER" tar czf - -C /data/uploads . > "$UP_PART"
UP_BYTES=$(wc -c < "$UP_PART" | tr -d ' ')

# gzip -t catches truncation; the listing proves the tar inside is coherent.
if ! gzip -t "$UP_PART" 2>/dev/null; then
    log "uploads archive fails its gzip integrity check"
    mkdir -p "$ROOT/failed" && mv "$UP_PART" "$ROOT/failed/$STAMP-uploads.tgz.bad"
    exit 1
fi
UP_FILES=$(tar tzf "$UP_PART" | grep -vc '/$' || true)
log "verified: ${UP_BYTES}B, ${UP_FILES} files"

# Both artefacts are good. Only now do they get their real names.
STAGE="publishing the artefacts"
mv "$DB_PART" "$DB_FINAL"
mv "$UP_PART" "$UP_FINAL"

# ---------------------------------------------------------------- weeklies ---
# Sunday's backup is also kept on the long cycle. Hard links, so eight weeks of
# history costs nothing until the daily copy is pruned away.
STAGE="linking the weekly copy"
if [ "$DOW" = "7" ]; then
    ln -f "$DB_FINAL" "$WEEKLY/$STAMP-db.dump" 2>/dev/null \
        || cp "$DB_FINAL" "$WEEKLY/$STAMP-db.dump"
    ln -f "$UP_FINAL" "$WEEKLY/$STAMP-uploads.tgz" 2>/dev/null \
        || cp "$UP_FINAL" "$WEEKLY/$STAMP-uploads.tgz"
    log "kept as the weekly for $TODAY"
fi

# ---------------------------------------------------------------- retention ---
# Reached only on success, which is the point. `ls -t` is newest-first, so
# tail skips the ones being kept.
prune() {
    dir=$1; pattern=$2; keep=$3
    ls -t "$dir"/$pattern 2>/dev/null | tail -n "+$((keep + 1))" | while read -r old; do
        log "pruning $(basename "$old")"
        rm -f "$old"
    done
}
STAGE="pruning old backups"
prune "$DAILY" '*-db.dump' "$KEEP_DAILY"
prune "$DAILY" '*-uploads.tgz' "$KEEP_DAILY"
prune "$WEEKLY" '*-db.dump' "$KEEP_WEEKLY"
prune "$WEEKLY" '*-uploads.tgz' "$KEEP_WEEKLY"

trap - EXIT INT TERM
write_status true "ok" "$DB_BYTES" "$UP_BYTES" "$TABLES"
log "=== done: $(ls -1 "$DAILY"/*-db.dump | wc -l | tr -d ' ') daily, $(ls -1 "$WEEKLY"/*-db.dump 2>/dev/null | wc -l | tr -d ' ') weekly ==="
