# Operations

Three scripts, meant to be run on the host where Stringline is deployed.

| Script | What it does |
|---|---|
| `backup.sh` | Dumps the database and uploads, verifies both, prunes old copies. Nightly. |
| `restore.sh` | Restores a dump — into a scratch database by default — and compares row counts. |
| `healthcheck.sh` | Checks the API, the database, backup freshness, disk and containers. Exits non-zero when something is wrong. |

They are plain POSIX `sh` with no dependencies beyond `docker`, `curl` and
busybox, so they run on a Synology NAS as readily as on a Linux host.

## A note on what these are guarding against

The failure these are written around is not a disk dying — it is **a backup
system that reports success while producing nothing usable.** That shapes three
decisions worth knowing about before editing them:

- **`backup.sh` prunes only after the new backup verifies.** Prune first, or
  prune unconditionally, and a fortnight of failures silently consumes the
  whole retention window. You find out on the day you need a restore.
- **Every artefact is written as `.part` and renamed only when complete**, so
  an interrupted run cannot leave a file that looks finished. The error path
  deletes its own `.part` files, because they match no retention glob and would
  otherwise accumulate forever.
- **The dump is read back with `pg_restore --list` before it counts.** A
  truncated dump is indistinguishable from a good one until you use it.

`healthcheck.sh` watches backup *freshness* for the same reason: a month-old
`"ok": true` is still a month with no backups.

## Scheduling on the Synology NAS

Both scheduled jobs need root, so they are registered in **DSM → Control Panel
→ Task Scheduler** rather than from a shell. Create → Scheduled Task → Script
for each.

**1. Stringline backup**

- Schedule: daily, 03:15
- User: `root`
- Script: `sh /volume1/docker/stringline/ops/backup.sh`
- Notification: tick **Send run details by email**, and tick **only when the
  script terminates abnormally**

**2. Stringline health**

- Schedule: daily, 08:00
- User: `root`
- Script: `sh /volume1/docker/stringline/ops/healthcheck.sh`
- Notification: same — email, abnormal termination only

The non-zero exit *is* the alarm. That is deliberate: no SMTP credentials live
in the repository, and there is no second notification path to keep working.
It does mean **DSM's own email has to be configured** (Control Panel →
Notification → Email) or the alarm is wired to nothing. Worth confirming by
running the health check with a deliberately broken URL once:

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
edits — a dump is a snapshot and production has moved on. Every table differing,
or a table missing, is not.

Restoring **over** production needs the intent spelled out in full:

```sh
sh restore.sh /path/to/dump --into stringline --yes-overwrite-production
```

Without that flag it refuses. A restore script that defaults to clobbering the
live database is a loaded gun left on the table.

## Where things live

```
/volume1/docker/stringline/           deploy target — source tarball lands here
/volume1/docker/stringline-backups/   NOT inside the above, deliberately
├── daily/      30 days of db dumps and upload archives
├── weekly/     8 Sundays, hard-linked so they cost nothing until pruned
├── failed/     artefacts that failed verification, kept to look at
├── status.json last run's outcome — what healthcheck.sh reads
└── backup.log  append-only history
```

Backups sit outside the deploy directory on purpose: that directory has a source
tarball extracted over it on every deploy, and one `rm -rf` to redeploy clean
would otherwise take every backup with it.
