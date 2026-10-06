#!/bin/sh
#
# Stringline health check.
#
# Exits non-zero when something is wrong, and says what in plain language. DSM
# Task Scheduler is configured to email on abnormal termination, so a non-zero
# exit *is* the alarm — no SMTP credentials live in here, and there is no second
# notification system to keep working.
#
# It checks the public URL rather than localhost:3006, so a passing run also
# proves Caddy, the TLS certificate and the /stringline/api path all still work.
# What it cannot see is whether the NAS is reachable from outside the house; for
# that you would need something off-site, which is a different job.
#
# Four things are checked, because "the port answers" has never been the
# interesting question:
#
#   1. The API answers at all.
#   2. It says its database is up — the endpoint actually queries.
#   3. A backup finished recently. Backups failing quietly for a month is the
#      exact scenario the retention logic was written to prevent, and the only
#      way to notice is to look.
#   4. There is still disk to write the next one onto.

set -u

URL=${STRINGLINE_HEALTH_URL:-https://kevinoue.com/stringline/api/health}
STATUS=/volume1/docker/stringline-backups/status.json
BACKUP_MAX_AGE_HOURS=36 # a nightly job may be a few hours late; two days is not late
DISK_MIN_GB=5

problems=""
note() {
    echo "PROBLEM: $1"
    problems="$problems$1; "
}
ok() { echo "ok: $1"; }

echo "=== stringline health $(date '+%Y-%m-%d %H:%M:%S') ==="

# ------------------------------------------------------------------ the api ---
# --max-time, because a hung connection must fail the check rather than hang
# the scheduled task until someone notices a stuck process.
body=$(curl -fsS --max-time 20 "$URL" 2>&1)
if [ $? -ne 0 ]; then
    note "the API did not answer at $URL ($body)"
elif ! echo "$body" | grep -q '"status":"ok"'; then
    note "the API answered but is not ok: $body"
elif ! echo "$body" | grep -q '"database":"up"'; then
    note "the API is up but its database is not: $body"
else
    ok "API and database ($URL)"
fi

# -------------------------------------------------------------- the backups ---
if [ ! -f "$STATUS" ]; then
    note "no backup status at $STATUS — has backup.sh ever run?"
else
    if grep -q '"ok": *true' "$STATUS"; then
        detail=ok
    else
        detail=$(sed -n 's/.*"detail": *"\([^"]*\)".*/\1/p' "$STATUS")
        note "the last backup failed: ${detail:-unknown}"
    fi

    # Freshness matters as much as success: a month-old "ok" is still a month
    # with no backups.
    age_s=$(( $(date +%s) - $(date -r "$STATUS" +%s) ))
    age_h=$(( age_s / 3600 ))
    if [ "$age_h" -gt "$BACKUP_MAX_AGE_HOURS" ]; then
        note "the last backup was ${age_h}h ago (limit ${BACKUP_MAX_AGE_HOURS}h)"
    elif [ "$detail" = ok ]; then
        ok "backup ${age_h}h old, $(sed -n 's/.*"tables": *\([0-9]*\).*/\1/p' "$STATUS") tables"
    fi
fi

# ------------------------------------------------------------------- the disk ---
# Checked here because the failure it causes is confusing: pg_dump writes a
# truncated file, and without this you would be reading dump-verification
# errors instead of "the disk is full".
avail_gb=$(df -k /volume1 | awk 'NR==2 {print int($4/1048576)}')
if [ -z "$avail_gb" ]; then
    note "could not read free space on /volume1"
elif [ "$avail_gb" -lt "$DISK_MIN_GB" ]; then
    note "only ${avail_gb}GB free on /volume1 (limit ${DISK_MIN_GB}GB)"
else
    ok "${avail_gb}GB free on /volume1"
fi

# --------------------------------------------------------------- containers ---
DOCKER=/volume1/@appstore/ContainerManager/usr/bin/docker
for c in stringline-api stringline-db; do
    state=$($DOCKER inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
    if [ "$state" != running ]; then
        note "container $c is $state"
    else
        # A container that restarts in a loop reports "running" at every glance.
        restarts=$($DOCKER inspect -f '{{.RestartCount}}' "$c" 2>/dev/null || echo 0)
        ok "$c running (restarts: $restarts)"
    fi
done

echo
if [ -n "$problems" ]; then
    echo "UNHEALTHY: $problems"
    exit 1
fi
echo "HEALTHY"
