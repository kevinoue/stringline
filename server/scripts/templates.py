"""
Templates: the built-in library, starting a project from one, and saving one.

A template is the shape of a plan — tasks, durations, links. It must carry no
dates, no actuals and no constraints, or it quietly becomes a stale copy of
last year's job.
"""
import json
import os
import random
import sys
import urllib.request

API = os.environ.get("STRINGLINE_API", "http://localhost:3006/stringline/api")
TOKEN = None
failures = []


def call(method, path, body=None):
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, (json.load(r) if r.status != 204 else None)
    except urllib.error.HTTPError as e:
        body = e.read()
        return e.code, (json.loads(body) if body else None)


def check(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        failures.append(label)


slug = f"tmpl-{random.randint(10000, 99999)}"
_, o = call("POST", "/auth/signup", {
    "companyName": "Template Co", "slug": slug,
    "email": "t@tmpl.test", "password": "correcthorse", "name": "Templater"})
TOKEN = o["token"]

print("\n== the built-in library ==")
status, o = call("GET", "/projects/templates")
names = [t["name"] for t in o["templates"]]
check("templates listed", status == 200 and len(names) >= 4, f"{len(names)} templates")
for want in ["Hotel seasonal closedown", "Hotel seasonal reopening",
             "Single-family home build", "Guest room renovation"]:
    check(f"built-in: {want}", want in names)
check("built-ins are marked as such", all(t["builtIn"] for t in o["templates"]))
for t in o["templates"]:
    print(f"     {t['name']:<28} {t['taskCount']:>3} tasks, {t['workingDays']:>3} working days")

closedown = next(t for t in o["templates"] if t["name"] == "Hotel seasonal closedown")

print("\n== starting a project from a template ==")
status, made = call("POST", "/projects/from-template", {
    "templateId": closedown["id"], "name": "Stonecliffe closedown 2026", "startDate": "2026-10-19"})
check("project created", status == 201, f"got {status}")
pid = made["projectId"]
check("all tasks copied", made["taskCount"] == closedown["taskCount"],
      f"{made['taskCount']} of {closedown['taskCount']}")

_, sc = call("GET", f"/projects/{pid}/schedule")
s = sc["schedule"]
print(f"     runs {s['projectStart']} → {s['projectFinish']} ({s['durationWorkingDays']} working days)")
check("the copy solves into a real schedule", s["projectFinish"] > s["projectStart"])
check("dependencies came across", len(sc["dependencies"]) >= 20, f"{len(sc['dependencies'])} links")
check("it has a critical path", len(s["criticalPath"]) > 0, f"{len(s['criticalPath'])} tasks")
check("phases were recreated",
      len({d["phaseId"] for d in sc["details"] if d["phaseId"]}) >= 4,
      str(len({d["phaseId"] for d in sc["details"] if d["phaseId"]})))
check("the closing milestone is client-visible",
      any(d["visibility"] == "client" and d["durationDays"] == 0 for d in sc["details"]))

# A template must not carry one project's history into the next.
check("no actuals were copied", all(not d["actualStart"] and not d["actualFinish"] for d in sc["details"]))
check("no constraints were copied", all(d["constraintType"] == "ASAP" for d in sc["details"]))

print("\n== saving a project as a template ==")
# Dirty the project first: the saved template must not inherit any of this.
first = sc["details"][0]
call("PATCH", f"/projects/{pid}/tasks/{first['id']}",
     {"actualStart": "2026-10-19", "actualFinish": "2026-10-21",
      "constraintType": "START_NO_EARLIER_THAN", "constraintDate": "2026-10-19"})

status, o = call("POST", f"/projects/{pid}/save-as-template", {
    "name": "Stonecliffe closedown", "description": "Our version", "category": "hospitality"})
check("saved", status == 201, f"got {status}")
tid = o["templateId"]

status, o = call("GET", "/projects/templates")
mine = next(t for t in o["templates"] if t["id"] == tid)
check("appears in the library", mine["name"] == "Stonecliffe closedown")
check("marked as ours, not built-in", mine["builtIn"] is False)

status, made2 = call("POST", "/projects/from-template", {
    "templateId": tid, "name": "Closedown 2027", "startDate": "2027-10-18"})
check("can start a project from a saved template", status == 201, f"got {status}")
_, sc2 = call("GET", f"/projects/{made2['projectId']}/schedule")
check("the dirtied task came back clean",
      all(not d["actualStart"] and d["constraintType"] == "ASAP" for d in sc2["details"]),
      "actuals or constraints leaked into the template")
check("links survived the round trip", len(sc2["dependencies"]) == len(sc["dependencies"]),
      f"{len(sc2['dependencies'])} vs {len(sc['dependencies'])}")

print("\n== rules ==")
status, _ = call("POST", f"/projects/{pid}/save-as-template", {"name": "Stonecliffe closedown"})
check("duplicate template name rejected", status == 409, f"got {status}")

status, _ = call("DELETE", f"/projects/templates/{closedown['id']}")
check("a built-in cannot be deleted", status == 404, f"got {status}")

status, _ = call("DELETE", f"/projects/templates/{tid}")
check("own template can be deleted", status == 204, f"got {status}")

# Another company must not see or use our template.
saved = TOKEN
_, o = call("POST", "/auth/signup", {
    "companyName": "Other", "slug": f"other-{random.randint(10000,99999)}",
    "email": "a@o.test", "password": "correcthorse", "name": "Other"})
TOKEN = o["token"]
_, o = call("GET", "/projects/templates")
check("another company sees only built-ins", all(t["builtIn"] for t in o["templates"]),
      f"{len(o['templates'])} visible")
TOKEN = saved

print("\n" + ("ALL TEMPLATE CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
