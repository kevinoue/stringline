# Operations

Four scripts, meant to be run on the host where Stringline is deployed.

| Script | What it does |
|---|---|
| `backup.sh` | Dumps the database and uploads, verifies both, prunes old copies. Nightly. |
| `restore.sh` | Restores a dump — into a scratch database by default — and compares row counts. |
| `healthcheck.sh` | Checks the API, database, backup freshness, disk and containers. Exits non-zero and emails when something is wrong. |
| `install-cron.sh` | Registers the two scheduled jobs in `/etc/crontab`. Synology-specific; run once, as root. |

Plain POSIX `sh`, no dependencies beyond `docker` and `curl`, so they run on a
Synology NAS as readily as on a Linux host.

## What these are guarding against

Not a disk dying — **a backup system that reports success while producing
nothing usable.** Three decisions follow from that, and each was verified by
deliberately breaking it:

- **`backup.sh` prunes only after the new backup verifies.** Prune first, or
  unconditionally, and a fortnight of failures silently consumes the whole
  retention window. You find out on the day you need a restore.
- **Artefacts are written as `.part` and renamed only when complete**, so an
  interrupted run cannot leave a file that looks finished. The error path
  deletes its own `.part` files — they match no retention glob, so nothing else
  ever would.
- **The dump is read back with `pg_restore --list` before it counts.** A
  truncated dump is indistinguishable from a good one until you use it.

`healthcheck.sh` watches backup *freshness* for the same reason: a month-old
`"ok": true` is still a month with no backups.

## Scheduling

```sh
sudo sh /volume1/docker/stringline/ops/install-cron.sh
```

That installs two tab-separated lines into `/etc/crontab` — backup at 03:15,
health check at 08:00 — after taking a timestamped backup of the file. It is
idempotent, so running it again replaces rather than duplicates.

### Why `/etc/crontab` and not the Task Scheduler

The DSM UI would be the natural home, and it is still where you should move
these if you ever want to see or edit them there. It is not what the script
uses because:

- **`synoschedtask` has no `--add`** in DSM 7.3.2 — only `--get`, `--del`,
  `--run` and `--sync`. Tasks cannot be created from the CLI.
- Task definitions live in `/usr/syno/etc/synoschedule.d/root/<id>.task`, an
  undocumented key-value format whose `cmd` field is base64 of a
  backslash-escaped string. Hand-writing one risks the Task Scheduler UI, and
  this NAS already has a `sched_status.sqlite.corrupt` sitting next to it.
- `/etc/cron.d/` exists but DSM uses it only for JSON descriptor comments with
  empty schedules, so it is not a general-purpose crontab directory here.

`/etc/crontab` is where DSM's own Task Scheduler writes its entries, so this is
the same mechanism rather than a parallel one.

**The caveat, stated plainly:** a DSM *major* version upgrade may rewrite
`/etc/crontab` and drop these lines. Nothing here detects that — the health
check cannot report its own absence. After any DSM upgrade, run:

```sh
grep '# stringline' /etc/crontab   # expect 2 lines
```

Fields must be **tab**-separated. DSM's crond ignores space-separated lines
without complaint, which is the classic way to install a cron job that never
runs. `install-cron.sh` uses `printf '\t'` for exactly this reason, and prints
the result through `cat -T` so you can see the tabs.

## Alerting

Copy `ops.env.example` to `ops.env` and put a Resend API key in it. Without
that file the health check still runs and still exits non-zero — it just writes
to `health.log` and **tells nobody**.

Resend rather than anything Synology-native, because the obvious options are
dead ends:

- **DSM's SMTP is not configured** on this NAS (`smtp_from_mail` is empty), so
  "email on abnormal termination" would have alarmed precisely nobody.
- **`MAILTO=""`** at the top of `/etc/crontab`, so cron mails nothing either.
- **`synodsmnotify` and `synonotify` only accept registered i18n message
  keys.** They reject arbitrary text outright — `title: '...' is neither mail
  string key nor i18n format` — so they cannot carry a custom alarm at all.

Configuring DSM email (Control Panel → Notification → Email) is still worth
doing for everything *else* the NAS wants to tell you. It just cannot be what
Stringline's alarm depends on.

Once the key is in place, watch it fire once. An alarm nobody has seen work is
not an alarm:

```sh
STRINGLINE_HEALTH_URL=https://kevinoue.com/stringline/api/nope \
  sh /volume1/docker/stringline/ops/healthcheck.sh
echo $?   # 1, and an email should arrive
```

## Proving the backups work

Run this on a normal day, not the day you need it:

```sh
sh /volume1/docker/stringline/ops/restore.sh
```

With no arguments it takes the newest dump, restores it into
`stringline_restoretest`, and prints every table's row count beside
production's. A few counts differing is expected when the dump predates recent
edits — a dump is a snapshot and production has moved on. Every table
differing, or a table missing, is not.

Restoring **over** production needs the intent spelled out in full:

```sh
sh restore.sh <dump> --into stringline --yes-overwrite-production
```

Without that flag it refuses. A restore script that defaults to clobbering the
live database is a loaded gun left on the table.

## Where things live

```
/volume1/docker/stringline/           deploy target — source tarball lands here
├── ops/                              these scripts, kept current by each deploy
└── ops.env                           alerting credentials, not in git

/volume1/docker/stringline-backups/   NOT inside the above, deliberately
├── daily/      30 days of db dumps and upload archives
├── weekly/     8 Sundays, hard-linked so they cost nothing until pruned
├── failed/     artefacts that failed verification, kept to look at
├── status.json last run's outcome — what healthcheck.sh reads
├── backup.log  append-only backup history
├── health.log  append-only health history
└── cron.log    whatever the scheduled runs printed, including crashes
```

Backups sit outside the deploy directory on purpose: that directory has a
source tarball extracted over it on every deploy, and one `rm -rf` to redeploy
clean would otherwise take every backup with it.

## Verified, not assumed

As of 5 October 2026, against the live deployment:

- A dump restored into a scratch database with **all 20 tables matching
  production's row counts** exactly.
- A deliberately broken backup exited non-zero, wrote `"ok": false`, removed
  its own `.part` file, and **did not prune** the good backup.
- All five health-check failure modes detected, with exit 1 when unhealthy and
  0 when healthy — the distinction every scheduler depends on.
- A marker job proved cron actually fires: scheduled for 21:43, written at
  21:43:01, as root.
- Both scripts run clean under `env -i` with cron's exact PATH, which is where
  "works in my shell" usually stops being true.
