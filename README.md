# Stringline

Construction and field-service project management.

A stringline is the taut line masons run to keep a course true — you build to it, and you can
see the moment something drifts off it. That is what this does for a schedule.

**Live demo:** https://kevinoue.com/stringline/ — company code `demo-wing`, `kev@demo.test` / `correcthorse`

---

## Why

Procore prices on annual construction volume — $15k–$30k/yr for a $10–50M contractor — and tells
six-person shops they aren't the target. Generic tools (Asana, Monday, ClickUp) fail structurally
rather than on features: the update tax falls on the people who get least from it, status leaks
into chat, and Gantt charts become fiction by week three because nobody re-baselines.

Stringline is free, has no AI in it, and does one thing properly: **it tells you what a slip cost
you, in a sentence.**

> Completion moved 3 days later, to 2026-02-05. Cause: Permit approval slipped 3 days. It is on
> the critical path.

## What it does

- **Real CPM scheduling** — finish-to-start, start-to-start, finish-to-finish and start-to-finish
  links with lead and lag, working-day calendars with holidays and per-crew shifts, constraints,
  total and free float, critical path.
- **Actuals and a data date** — the line between what happened and what is forecast. Remaining
  work resumes at the data date, so a stalled task stops claiming it will finish on time.
- **Baselines** — freeze the plan, then see every bar's ghost behind the live one. Variance is
  measured in working days, never calendar days.
- **Root-cause attribution** — when one task slips, twenty move. Stringline names the one that
  caused it rather than blaming all twenty.
- **A living summary** — the project in plain English, recomputed on every load. Computed, not
  generated; every figure is one the solver stands behind.
- **What-if** — drag a bar, see the ripple, then apply or discard. Nothing is written until you
  accept the consequence.
- **Templates** — including seasonal hotel closedown and reopening, which nothing else ships.
  Save any project as a template.

## Design notes

A few decisions that are load-bearing, and the reasons they are:

- **The engine is pure.** `server/src/scheduler/` has no database, no HTTP and no clock. It is
  the one module where a silent wrong answer poisons everything above it, so it stays
  exhaustively testable in isolation. 10,500 tasks solve in ~47 ms.
- **Time is an integer day index in UTC.** Calendar dates exist only at the boundary. This is
  where day-granular schedulers usually break.
- **Every rejection is typed.** The solver never returns a best-effort schedule. A dependency
  cycle is reported with the actual loop, because an error someone can fix beats one they can
  only stare at.
- **The server decides what a drag means.** Turning "the left edge landed on this date" into a
  duration needs the project's calendars, which the browser does not have.

Each of these is commented at the point it matters, usually with the failure that produced the
rule — the calendars precompute because day-by-day walking made large schedules crawl; the wheel
listener is attached natively because React's passive handlers silently swallow
`preventDefault`.

## Installing it

With Docker, from a clone:

```bash
sh ops/install.sh
```

That generates a `.env` with real secrets, brings up the API and PostgreSQL,
and prints a **setup code**. Open the web app, enter the code, and create your
company and owner account. Setup stops working the moment a company exists.

The code is printed to the server log rather than shown on the page on purpose.
WordPress's open install page is a real vulnerability — between starting the
containers and filling in the form, whoever reaches the URL first owns the
instance, and on a public URL that race is not hypothetical. Reading the
container log requires access to the host, which is the thing that
distinguishes you from a stranger who found the URL. Jenkins does the same.

If you lose it:

```bash
docker compose logs api | grep -B2 -A6 'no accounts yet'
```

It is derived from `JWT_SECRET`, so it survives a restart part-way through.

### Running it from source

Requires Node 24+ and PostgreSQL 16.

```bash
createdb stringline
cd server && npm install && npm run build
DATABASE_URL=postgresql://localhost/stringline JWT_SECRET=$(openssl rand -base64 32) npm start

cd ../web && npm install && npm run dev
```

Migrations run automatically at boot — and the runner refuses to start if it cannot find them,
rather than reporting "schema up to date" against a database that is missing every table.

`docker-compose.yml` brings up the API and PostgreSQL together. Set `JWT_SECRET` and
`POSTGRES_PASSWORD` in a `.env` beside it (see `.env.example`); the Postgres password must be
hex, because it is interpolated into a `postgresql://` URL where `/`, `+` and `=` break parsing.

The API mounts itself at `BASE_PATH` and the web app builds for `VITE_BASE`, so it can live
under a subpath or at a domain root without code changes.

### Tests

```bash
cd server
npm test                                   # 64 unit + integration tests
python3 scripts/smoke.py                   # 32 HTTP checks against a running server
python3 scripts/drag.py                    # drag semantics
python3 scripts/templates.py               # templates
cd ../web && npm run shoot                 # headless-browser checks + screenshots
```

`scripts/setup.py` and `web/scripts/setup-shoot.mjs` cover first-run setup, and
need the opposite starting conditions from everything else — a database with no
companies in it. Run them against a throwaway database, with the same
`JWT_SECRET` the server was started with:

```bash
createdb stringline_setuptest
DATABASE_URL=postgresql://localhost/stringline_setuptest JWT_SECRET=whatever npm start
STRINGLINE_JWT_SECRET=whatever python3 scripts/setup.py
```

## Licence

Stringline is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

In short: use it, run it, modify it, free of charge. If you modify it and make it available to
others over a network, AGPL section 13 requires you to offer them the source of your modified
version.

### Commercial licensing

If AGPL does not suit you — for example you want to build Stringline into a closed-source product
or offer it as a hosted service without publishing your changes — a commercial licence is
available. The copyright is held solely by Kevin Ouellette, so it can be relicensed by agreement.

Get in touch: kev.oue@gmail.com

Contributions are welcome, but note that accepting one means agreeing it can be included under
both the AGPL and any commercial licence.
