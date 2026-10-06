"""
Seed a realistic renovation schedule for looking at the Gantt.

Modelled loosely on a hotel wing refurbishment: sequential phases with parallel
trades, a permit that runs long, a milestone at handover, and progress applied
against a data date so the chart shows fact and forecast either side of a line.

Usage:  python3 scripts/seed.py [company-slug]
Prints the login credentials it created.
"""
import json
import random
import sys
import urllib.request

import os
API = os.environ.get("STRINGLINE_API", "http://localhost:3006/stringline/api")
TOKEN = None


def call(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> {e.code}: {e.read().decode()}")


slug = sys.argv[1] if len(sys.argv) > 1 else f"demo-{random.randint(1000, 9999)}"
email, password = "kev@demo.test", "correcthorse"

TOKEN = call("POST", "/auth/signup", {
    "companyName": "Northshore Builders", "slug": slug,
    "email": email, "password": password, "name": "Kevin"})["token"]

project = call("POST", "/projects", {
    "name": "Stonecliffe west wing refurbishment",
    "startDate": "2026-01-05",
    "deadline": "2026-04-10"})["project"]
pid = project["id"]

# (key, label, working days)
TASKS = [
    ("permit",     "Permit approval",            5),
    ("demo",       "Strip out and demolition",   8),
    ("abate",      "Asbestos abatement",         4),
    ("m1",         "Demolition complete",        0),
    ("frame",      "Framing",                   10),
    ("rough_e",    "Electrical rough-in",        6),
    ("rough_p",    "Plumbing rough-in",          5),
    ("hvac",       "HVAC ductwork",              7),
    ("inspect",    "Rough-in inspection",        2),
    ("m2",         "Rough-in signed off",        0),
    ("insul",      "Insulation",                 3),
    ("drywall",    "Drywall and tape",           9),
    ("paint",      "Paint",                      6),
    ("floor",      "Flooring",                   7),
    ("fixtures",   "Fixtures and trim",          5),
    ("joinery",    "Joinery and millwork",       8),
    ("commission", "Commissioning",              4),
    ("snag",       "Snagging",                   5),
    ("m3",         "Handover",                   0),
]

ids = {}
for key, label, days in TASKS:
    ids[key] = call("POST", f"/projects/{pid}/tasks",
                    {"name": label, "durationDays": days})["taskId"]

LINKS = [
    ("permit", "demo", "FS", 0),
    ("permit", "abate", "FS", 0),
    ("demo", "m1", "FS", 0),
    ("abate", "m1", "FS", 0),
    ("m1", "frame", "FS", 0),
    ("frame", "rough_e", "FS", -2),   # electricians start before framing finishes
    ("frame", "rough_p", "FS", 0),
    ("frame", "hvac", "FS", 0),
    ("rough_e", "inspect", "FS", 0),
    ("rough_p", "inspect", "FS", 0),
    ("hvac", "inspect", "FS", 0),
    ("inspect", "m2", "FS", 0),
    ("m2", "insul", "FS", 0),
    ("insul", "drywall", "FS", 0),
    ("drywall", "paint", "FS", 1),    # a day for the mud to dry
    ("paint", "floor", "FS", 0),
    ("paint", "joinery", "FS", 0),
    ("floor", "fixtures", "FS", 0),
    ("joinery", "fixtures", "FS", 0),
    ("fixtures", "commission", "FS", 0),
    ("commission", "snag", "FS", 0),
    ("snag", "m3", "FS", 0),
]
for pred, succ, kind, lag in LINKS:
    call("POST", f"/projects/{pid}/dependencies",
         {"predecessorId": ids[pred], "successorId": ids[succ], "type": kind, "lagDays": lag})

# Baseline the plan before anything goes wrong — that is the whole point.
baseline = call("POST", f"/projects/{pid}/baselines", {"name": "Contract baseline"})["baseline"]

# Now apply reality. The permit ran three days long, demolition is finished,
# abatement is under way, and framing has started out of sequence.
call("PATCH", f"/projects/{pid}/tasks/{ids['permit']}",
     {"actualStart": "2026-01-05", "actualFinish": "2026-01-14"})
call("PATCH", f"/projects/{pid}/tasks/{ids['demo']}",
     {"actualStart": "2026-01-15", "actualFinish": "2026-01-27"})
call("PATCH", f"/projects/{pid}/tasks/{ids['abate']}",
     {"actualStart": "2026-01-15", "percentComplete": 50})
result = call("PATCH", f"/projects/{pid}/tasks/{ids['frame']}", {"durationDays": 12})

print(f"company code : {slug}")
print(f"email        : {email}")
print(f"password     : {password}")
print(f"project      : {pid}")
print(f"baselined    : {baseline['projectFinish']}")
print(f"now forecast : {result['schedule']['projectFinish']}")
if result.get("impact"):
    print(f"impact       : {result['impact']['summary']}")
