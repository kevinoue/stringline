"""
Phases — the grouping that makes a schedule readable on a small screen.

Phases were in the schema from the start and arrived with templates, but
nothing could create or change one. So 28 of 83 projects had phases and the
other 55 could never get them, and the task editor had no control at all.

The rule worth protecting here: **a phase groups work, it does not own it.**
Deleting a phase must leave every task alive and unassigned. Losing twelve
tasks because someone tidied up a heading would be unforgivable.
"""
import json
import os
import random
import sys
import urllib.error
import urllib.request

API = os.environ.get("STRINGLINE_API", "http://localhost:3006/stringline/api")
failures = []


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, (json.load(r) if r.status != 204 else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"null")
        except Exception:
            return e.code, {"raw": raw[:160].decode("latin1")}


def check(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        failures.append(label)


slug = f"ph{random.randint(10000, 99999)}"
_, o = call("POST", "/auth/signup", {
    "companyName": "Phase Co", "slug": slug,
    "email": "owner@phase.test", "password": "correcthorse", "name": "Owner"})
owner = o["token"]

_, o = call("POST", "/projects", {"name": "Tower block", "startDate": "2026-11-02"}, owner)
project = o["project"]["id"]

print("\n== a blank project has no phases, and that is fine ==")
st, o = call("GET", f"/projects/{project}/schedule", None, owner)
check("the schedule includes a phases list", "phases" in (o or {}), str(list((o or {}).keys())))
check("and it is empty to start", o.get("phases") == [], str(o.get("phases")))

print("\n== creating ==")
st, o = call("POST", f"/projects/{project}/phases", {"name": "  Sitework  "}, owner)
check("a phase can be created", st == 201, f"got {st} {str(o)[:100]}")
sitework = (o or {}).get("phase", {})
check("the name is trimmed", sitework.get("name") == "Sitework", str(sitework.get("name")))
check("phases default to client-visible", sitework.get("visibility") == "client", str(sitework))

st, o = call("POST", f"/projects/{project}/phases", {"name": "Structure"}, owner)
structure = o["phase"]
st, o = call("POST", f"/projects/{project}/phases", {"name": "Fit-out"}, owner)
fitout = o["phase"]

check("each new phase is appended, not prepended",
      [sitework["sortOrder"], structure["sortOrder"], fitout["sortOrder"]] == [0, 1, 2],
      str([sitework["sortOrder"], structure["sortOrder"], fitout["sortOrder"]]))

st, _ = call("POST", f"/projects/{project}/phases", {"name": "   "}, owner)
check("a blank name is rejected", st == 400, f"got {st}")
st, _ = call("POST", f"/projects/{project}/phases", {}, owner)
check("a missing name is rejected", st == 400, f"got {st}")

print("\n== filing tasks under a phase ==")
_, o = call("POST", f"/projects/{project}/tasks", {"name": "Excavate", "durationDays": 5}, owner)
excavate = o["taskId"]
_, o = call("POST", f"/projects/{project}/tasks", {"name": "Pour footings", "durationDays": 4}, owner)
footings = o["taskId"]
_, o = call("POST", f"/projects/{project}/tasks", {"name": "Erect steel", "durationDays": 10}, owner)
steel = o["taskId"]

st, _ = call("PATCH", f"/projects/{project}/tasks/{excavate}", {"phaseId": sitework["id"]}, owner)
check("a task can be filed under a phase", st == 200, f"got {st}")
call("PATCH", f"/projects/{project}/tasks/{footings}", {"phaseId": sitework["id"]}, owner)
call("PATCH", f"/projects/{project}/tasks/{steel}", {"phaseId": structure["id"]}, owner)

st, o = call("GET", f"/projects/{project}/schedule", None, owner)
by_id = {d["id"]: d for d in o["details"]}
check("the assignment comes back on the task",
      by_id[excavate]["phaseId"] == sitework["id"], str(by_id[excavate]["phaseId"]))
check("all three phases are listed", len(o["phases"]) == 3, str(len(o["phases"])))

st, _ = call("PATCH", f"/projects/{project}/tasks/{excavate}", {"phaseId": None}, owner)
check("and a task can be taken out of a phase again", st == 200, f"got {st}")
call("PATCH", f"/projects/{project}/tasks/{excavate}", {"phaseId": sitework["id"]}, owner)

print("\n== renaming and reordering ==")
st, o = call("PATCH", f"/projects/{project}/phases/{structure['id']}",
             {"name": "Superstructure"}, owner)
check("a phase can be renamed", st == 200, f"got {st}")
check("and comes back with the new name",
      o["phase"]["name"] == "Superstructure", str(o["phase"]))

st, _ = call("PATCH", f"/projects/{project}/phases/{structure['id']}", {"name": "  "}, owner)
check("renaming to blank is rejected", st == 400, f"got {st}")
st, _ = call("PATCH", f"/projects/{project}/phases/{structure['id']}", {}, owner)
check("an empty change is rejected", st == 400, f"got {st}")

st, o = call("PUT", f"/projects/{project}/phases/order",
             {"order": [fitout["id"], structure["id"], sitework["id"]]}, owner)
check("phases can be reordered in one request", st == 200, f"got {st}")
check("and come back in the new order",
      [p["name"] for p in o["phases"]] == ["Fit-out", "Superstructure", "Sitework"],
      str([p["name"] for p in o["phases"]]))

st, _ = call("PUT", f"/projects/{project}/phases/order", {"order": []}, owner)
check("an empty order is rejected", st == 400, f"got {st}")

print("\n== deleting a phase keeps its work ==")
st, o = call("DELETE", f"/projects/{project}/phases/{sitework['id']}", None, owner)
check("a phase can be deleted", st == 200, f"got {st}")
check("and it says how many tasks came loose",
      (o or {}).get("unassignedTasks") == 2, str(o))

st, o = call("GET", f"/projects/{project}/schedule", None, owner)
by_id = {d["id"]: d for d in o["details"]}
check("THE TASKS SURVIVE", len(o["details"]) == 3, f"{len(o['details'])} tasks")
check("they are simply unassigned", by_id[excavate]["phaseId"] is None, str(by_id[excavate]["phaseId"]))
check("and are still in the schedule", excavate in o["schedule"]["tasks"])
check("the phase itself is gone", len(o["phases"]) == 2, str(len(o["phases"])))

st, _ = call("DELETE", f"/projects/{project}/phases/{sitework['id']}", None, owner)
check("deleting it twice is a 404, not a crash", st == 404, f"got {st}")

print("\n== permissions and isolation ==")
_, o = call("POST", "/team/invites", {"email": "hand@phase.test", "role": "field"}, owner)
_, o = call("POST", f"/team/invites/{o['invite']['token']}/accept", {"password": "fieldpassword"})
field = o["token"]

st, _ = call("POST", f"/projects/{project}/phases", {"name": "Sneaky"}, field)
check("a field user cannot create a phase", st == 403, f"got {st}")
st, _ = call("PATCH", f"/projects/{project}/phases/{structure['id']}", {"name": "Hmm"}, field)
check("nor rename one", st == 403, f"got {st}")
st, _ = call("DELETE", f"/projects/{project}/phases/{structure['id']}", None, field)
check("nor delete one", st == 403, f"got {st}")

other = f"oth{random.randint(10000, 99999)}"
_, o = call("POST", "/auth/signup", {
    "companyName": "Other", "slug": other,
    "email": "o@other.test", "password": "correcthorse", "name": "O"})
outsider = o["token"]

st, _ = call("POST", f"/projects/{project}/phases", {"name": "Theirs"}, outsider)
check("another company cannot add a phase to our project", st == 404, f"got {st}")
st, _ = call("PATCH", f"/projects/{project}/phases/{structure['id']}", {"name": "X"}, outsider)
check("nor rename ours", st == 404, f"got {st}")
st, _ = call("DELETE", f"/projects/{project}/phases/{structure['id']}", None, outsider)
check("nor delete ours", st == 404, f"got {st}")

print("\n== templates still bring their own phases ==")
_, o = call("GET", "/projects/templates", None, owner)
closedown = next((t for t in o["templates"] if "closedown" in t["name"].lower()
                  or "close" in t["name"].lower()), None)
if closedown:
    _, o = call("POST", "/projects/from-template",
                {"templateId": closedown["id"], "name": "Hotel close",
                 "startDate": "2026-11-02"}, owner)
    made = o["projectId"]
    _, o = call("GET", f"/projects/{made}/schedule", None, owner)
    n = len(o["phases"])
    check(f"a template project arrives with phases ({closedown['name']})", n > 0, f"{n} phases")
    # The whole reason phases matter: a handful of bars instead of twenty-odd.
    check("and far fewer phases than tasks",
          n < len(o["details"]), f"{n} phases, {len(o['details'])} tasks")
else:
    print("  SKIP  no closedown template found to check")

print("\n" + ("ALL PHASE CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
