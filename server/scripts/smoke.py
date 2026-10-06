"""End-to-end drive of the Baseline HTTP API against a live server."""
import json
import random
import urllib.request

import os
API = os.environ.get("STRINGLINE_API", "http://localhost:3006/stringline/api")
TOKEN = None


def call(method, path, body=None, expect=None):
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
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def ok(label, condition, detail=""):
    print(f"  {'PASS' if condition else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    return condition


failures = []


def check(label, condition, detail=""):
    if not ok(label, condition, detail):
        failures.append(label)


slug = f"acme-{random.randint(10000, 99999)}"

print("\n== health is public ==")
# A router mounted at '/' with router-level auth once put this behind a token
# and broke every monitor and the deploy check along with it.
status, out = call("GET", "/health")
check("health needs no token", status == 200, f"got {status} {out}")
check("and reports the database", (out or {}).get("database") == "up", str(out))

print("\n== auth ==")
status, out = call("POST", "/auth/signup", {
    "companyName": "Acme Renovation", "slug": slug,
    "email": "kev@acme.test", "password": "correcthorse", "name": "Kevin"})
check("signup returns 201 + token", status == 201 and "token" in out)

status, out = call("POST", "/auth/signup", {
    "companyName": "Dup", "slug": slug,
    "email": "x@y.test", "password": "correcthorse", "name": "X"})
check("duplicate slug rejected", status == 409, f"got {status}")

status, out = call("POST", "/auth/signup", {
    "companyName": "Weak", "slug": f"{slug}-2",
    "email": "x@y.test", "password": "short", "name": "X"})
check("short password rejected", status == 400)

status, out = call("POST", "/auth/login", {
    "slug": slug, "email": "kev@acme.test", "password": "correcthorse"})
check("login succeeds", status == 200 and out.get("user", {}).get("role") == "owner")
TOKEN = out["token"]

# A non-existent company must look identical to a bad password, or the
# customer list is enumerable.
_, wrong_pw = call("POST", "/auth/login", {"slug": slug, "email": "kev@acme.test", "password": "nope"})
_, no_co = call("POST", "/auth/login", {"slug": "does-not-exist", "email": "a@b.c", "password": "nope"})
check("unknown company indistinguishable from bad password", wrong_pw == no_co, str(no_co))

print("\n== project + schedule ==")
status, out = call("POST", "/projects", {"name": "Wing refurb", "startDate": "2026-01-05"})
check("project created", status == 201)
pid = out["project"]["id"]

ids = {}
for name, dur in [("Permit approval", 5), ("Framing", 10), ("Drywall", 5), ("Handover", 0)]:
    status, out = call("POST", f"/projects/{pid}/tasks", {"name": name, "durationDays": dur})
    ids[name] = out["taskId"]
check("four tasks created", len(ids) == 4)

chain = [("Permit approval", "Framing"), ("Framing", "Drywall"), ("Drywall", "Handover")]
for pred, succ in chain:
    status, out = call("POST", f"/projects/{pid}/dependencies", {
        "predecessorId": ids[pred], "successorId": ids[succ], "type": "FS"})
    if status != 201:
        check(f"link {pred}->{succ}", False, str(out))
check("chain linked", True)

status, out = call("GET", f"/projects/{pid}/schedule")
sched = out["schedule"]
print(f"     finish {sched['projectFinish']}, critical path {len(sched['criticalPath'])} tasks")
for t in sorted(sched["tasks"].values(), key=lambda t: t["earlyStart"]):
    print(f"       {t['name']:<18} {t['earlyStart']} -> {t['earlyFinish']}  float={t['totalFloat']}")
check("finish is 2026-02-02", sched["projectFinish"] == "2026-02-02", sched["projectFinish"])
check("all four on critical path", len(sched["criticalPath"]) == 4)

print("\n== client view ==")
status, out = call("GET", f"/projects/{pid}/client-view")
names = [m["name"] for m in out["milestones"]]
check("client sees only the milestone", names == ["Handover"], str(names))
check("client sees the finish date", out["projectFinish"] == "2026-02-02")

print("\n== cycles ==")
status, out = call("POST", f"/projects/{pid}/dependencies", {
    "predecessorId": ids["Handover"], "successorId": ids["Permit approval"], "type": "FS"})
check("cycle rejected with 422", status == 422, f"got {status}")
check("cycle names the loop", out.get("code") == "CYCLE" and len(out.get("detail", [])) > 1, str(out.get("detail")))
status, out = call("GET", f"/projects/{pid}/schedule")
check("schedule intact after rejected cycle", out["schedule"]["projectFinish"] == "2026-02-02")

print("\n== what-if ==")
status, out = call("POST", f"/projects/{pid}/what-if", {
    "tasks": [{"id": ids["Permit approval"], "durationDays": 8}]})
check("what-if shows the ripple", out["hypotheticalFinish"] == "2026-02-05", str(out.get("hypotheticalFinish")))
status, out = call("GET", f"/projects/{pid}/schedule")
check("what-if did not persist", out["schedule"]["projectFinish"] == "2026-02-02")

print("\n== baseline + impact ==")
status, out = call("POST", f"/projects/{pid}/baselines", {"name": "Contract baseline"})
check("baseline captured", status == 201 and out["baseline"]["projectFinish"] == "2026-02-02")

status, out = call("PATCH", f"/projects/{pid}/tasks/{ids['Permit approval']}", {"durationDays": 8})
check("slip moved finish 3 days", out["finishMovedDays"] == 3, str(out.get("finishMovedDays")))
print(f"     banner: {out['impact']['summary']}")
check("impact names the single root cause",
      out["impact"]["summary"] ==
      "Completion moved 3 days later, to 2026-02-05. "
      "Cause: Permit approval slipped 3 days. It is on the critical path.")

print("\n== history ==")
status, out = call("GET", f"/projects/{pid}/history")
impactful = [h for h in out["history"] if h["impact_days"] != 0]
check("change log recorded the impact", len(impactful) >= 1 and impactful[0]["impact_days"] == 3)
check("history names the actor", impactful[0]["actor_name"] == "Kevin", str(impactful[0].get("actor_name")))

print("\n== progress tracking ==")
status, out = call("PATCH", f"/projects/{pid}/tasks/{ids['Permit approval']}", {
    "actualStart": "2026-01-05", "actualFinish": "2026-01-14"})
task = out["schedule"]["tasks"][ids["Permit approval"]]
check("completed task is fact, not forecast", task["status"] == "complete" and task["isForecast"] is False)
check("completed task off the critical path", task["isCritical"] is False)

print("\n== isolation ==")
# A second company must not be able to see the first one's project.
slug2 = f"other-{random.randint(10000, 99999)}"
saved = TOKEN
TOKEN = None
_, out = call("POST", "/auth/signup", {
    "companyName": "Other Co", "slug": slug2,
    "email": "a@other.test", "password": "correcthorse", "name": "Other"})
TOKEN = out["token"]
status, out = call("GET", f"/projects/{pid}/schedule")
check("cross-company read is 404", status == 404, f"got {status}")
status, out = call("PATCH", f"/projects/{pid}/tasks/{ids['Framing']}", {"durationDays": 99})
check("cross-company write is 404", status == 404, f"got {status}")
TOKEN = saved

print("\n" + ("ALL CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
