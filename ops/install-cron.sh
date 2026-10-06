#!/bin/sh
# Register the Stringline backup and health jobs in /etc/crontab.
#
# /etc/crontab is where DSM's own Task Scheduler writes its entries, so this is
# the same mechanism rather than a parallel one. Fields MUST be tab-separated;
# DSM's crond silently ignores space-separated lines, which is the classic way
# to install a cron job that never runs.
set -eu

CRONTAB=/etc/crontab
OPS=/volume1/docker/stringline/ops
LOGDIR=/volume1/docker/stringline-backups
MARK='# stringline'

mkdir -p "$LOGDIR"

# Idempotent: strip any previous Stringline lines before adding, so running
# this twice does not schedule two backups a night.
if grep -q "$MARK" "$CRONTAB" 2>/dev/null; then
    echo "removing previous stringline entries"
    grep -v "$MARK" "$CRONTAB" > /tmp/crontab.new
else
    cp "$CRONTAB" /tmp/crontab.new
fi

cp "$CRONTAB" "$CRONTAB.bak-$(date +%Y%m%d-%H%M%S)"

{
    printf '15\t3\t*\t*\t*\troot\t/bin/sh %s/backup.sh >> %s/cron.log 2>&1 %s\n' \
        "$OPS" "$LOGDIR" "$MARK"
    printf '0\t8\t*\t*\t*\troot\t/bin/sh %s/healthcheck.sh >> %s/cron.log 2>&1 %s\n' \
        "$OPS" "$LOGDIR" "$MARK"
} >> /tmp/crontab.new

# Validate before installing. A malformed /etc/crontab can stop *every* DSM
# scheduled task, including the ones that were here first.
if [ "$(awk 'NF && $0 !~ /^#/ && $0 !~ /^[A-Z_]+=/ {print NF}' /tmp/crontab.new | sort -u | tr -d '\n')" = "" ]; then
    echo "refusing to install: no valid job lines parsed"
    exit 1
fi

cat /tmp/crontab.new > "$CRONTAB"
chmod 644 "$CRONTAB"
rm -f /tmp/crontab.new

echo "--- stringline lines now in $CRONTAB (shown with tabs as ^I) ---"
grep "$MARK" "$CRONTAB" | cat -T

# crond runs with inotify by default on DSM 7, so it should pick this up on its
# own; the restart makes that certain rather than probable.
if systemctl restart crond 2>/dev/null; then
    echo "crond restarted via systemctl"
elif /usr/syno/sbin/synoservice --restart crond 2>/dev/null; then
    echo "crond restarted via synoservice"
else
    echo "NOTE: could not restart crond — inotify should still pick up the change"
fi

echo "--- crond running? ---"
pgrep -l crond || echo "crond NOT running"
