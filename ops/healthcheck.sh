#!/bin/sh
#
# Stringline health check.
#
# Exits non-zero when something is wrong and says what in plain language, so it
# is useful from a shell or from any scheduler that reports failures.
#
# It also raises a DSM notification itself, rather than relying on the
# scheduler to report the failure for it. That is not belt-and-braces: cron on
# this NAS runs with MAILTO="" and DSM's own SMTP is unconfigured
# (smtp_from_mail is empty), so a non-zero exit alone would have alarmed
# precisely nobody. An alarm you have not watched fire is not an alarm.
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

HEALTH_LOG=/volume1/docker/stringline-backups/health.log

# Alerting goes through Resend, with the key read from a file outside the
# repository. Not the first choice — DSM has notification CLIs — but
# `synodsmnotify` and `synonotify` only accept registered i18n message keys and
# reject arbitrary text outright, so they cannot carry a custom alarm at all.
#
# No key means log-only and a non-zero exit. That is the same degrade-quietly
# rule the app's own email service follows, and it is what makes this script
# safe to hand to someone self-hosting.
ALERT_ENV=${STRINGLINE_ALERT_ENV:-/volume1/docker/stringline/ops.env}

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
    [ -w "$(dirname "$HEALTH_LOG")" ] 2>/dev/null \
        && echo "$(date '+%Y-%m-%d %H:%M:%S')  UNHEALTHY: $problems" >> "$HEALTH_LOG"

    if [ -f "$ALERT_ENV" ]; then
        # shellcheck disable=SC1090
        . "$ALERT_ENV"
        if [ -n "${RESEND_API_KEY:-}" ] && [ -n "${ALERT_EMAIL:-}" ]; then
            # The problems string is interpolated into JSON, so the characters
            # that would break it have to go. A mangled alert still arrives;
            # an invalid one is rejected and you hear nothing.
            safe=$(echo "$problems" | tr -d '"\\\n\r' | cut -c1-900)
            if curl -fsS --max-time 20 -X POST https://api.resend.com/emails \
                -H "Authorization: Bearer $RESEND_API_KEY" \
                -H "Content-Type: application/json" \
                -d "{\"from\":\"${ALERT_FROM:-onboarding@resend.dev}\",
                     \"to\":[\"$ALERT_EMAIL\"],
                     \"subject\":\"Stringline is unhealthy\",
                     \"text\":\"$safe\"}" >/dev/null 2>&1
            then
                echo "(alert emailed to $ALERT_EMAIL)"
            else
                echo "(ALERT EMAIL FAILED — the problem above went unreported)"
            fi
        else
            echo "(no RESEND_API_KEY/ALERT_EMAIL in $ALERT_ENV — logged only)"
        fi
    else
        echo "(no $ALERT_ENV — logged only, nobody has been told)"
    fi
    exit 1
fi
[ -w "$(dirname "$HEALTH_LOG")" ] 2>/dev/null \
    && echo "$(date '+%Y-%m-%d %H:%M:%S')  healthy" >> "$HEALTH_LOG"
echo "HEALTHY"
