"""
Verify the editing surface: create, edit, delete, link, unlink — and that the
drag rules actually bite.

Regression cover for two bugs found in the deployed demo on 2026-09-15:
  * dragging a completed task offered an Apply that could never do anything
  * dragging any task earlier sent SNET, which is a floor and so did nothing
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
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def check(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        failures.append(label)


slug = f"edit-{random.randint(10000, 99999)}"
_, out = call("POST", "/auth/signup", {
    "companyName": "Edit Co", "slug": slug,
    "email": "e@edit.test", "password": "correcthorse", "name": "Editor"})
TOKEN = out["token"]

_, out = call("POST", "/projects", {"name": "Editable", "startDate": "2026-01-05"})
pid = out["project"]["id"]

print("\n== create ==")
status, a = call("POST", f"/projects/{pid}/tasks", {"name": "Dig footings", "durationDays": 5})
check("task created", status == 201, f"got {status}")
_, b = call("POST", f"/projects/{pid}/tasks", {"name": "Pour concrete", "durationDays": 3})
_, m = call("POST", f"/projects/{pid}/tasks", {"name": "Slab signed off", "durationDays": 0})
ids = {"a": a["taskId"], "b": b["taskId"], "m": m["taskId"]}

status, out = call("POST", f"/projects/{pid}/dependencies", {
    "predecessorId": ids["a"], "successorId": ids["b"], "type": "FS"})
check("dependency created", status == 201, f"got {status}")
call("POST", f"/projects/{pid}/dependencies",
     {"predecessorId": ids["b"], "successorId": ids["m"], "type": "FS"})

_, sched = call("GET", f"/projects/{pid}/schedule")
check("schedule returns editable details", len(sched.get("details", [])) == 3,
      f"{len(sched.get('details', []))} details")
check("dependencies carry ids", all("id" in d for d in sched["dependencies"]))
check("milestone auto client-visible",
      next(d for d in sched["details"] if d["id"] == ids["m"])["visibility"] == "client")

print("\n== edit ==")
status, out = call("PATCH", f"/projects/{pid}/tasks/{ids['a']}", {"name": "Dig footings (revised)", "durationDays": 8})
check("rename + reduration", status == 200)
check("downstream moved", out["schedule"]["tasks"][ids["b"]]["earlyStart"] == "2026-01-15",
      out["schedule"]["tasks"][ids["b"]]["earlyStart"])

print("\n== the SNET floor bug ==")
# Dragging LATER works: SNET is a floor, so it pushes.
status, out = call("POST", f"/projects/{pid}/what-if", {"tasks": [
    {"id": ids["b"], "constraintType": "START_NO_EARLIER_THAN", "constraintDate": "2026-01-22"}]})
check("drag later moves the task", out["schedule"]["tasks"][ids["b"]]["earlyStart"] == "2026-01-22")

# Dragging EARLIER with SNET does nothing — this is the bug the UI used to hit.
status, out = call("POST", f"/projects/{pid}/what-if", {"tasks": [
    {"id": ids["b"], "constraintType": "START_NO_EARLIER_THAN", "constraintDate": "2026-01-08"}]})
check("drag earlier via SNET is a genuine no-op (why the UI must not send it)",
      out["schedule"]["tasks"][ids["b"]]["earlyStart"] == "2026-01-15",
      out["schedule"]["tasks"][ids["b"]]["earlyStart"])

# Relaxing a real constraint is what dragging left must do instead.
call("PATCH", f"/projects/{pid}/tasks/{ids['b']}",
     {"constraintType": "START_NO_EARLIER_THAN", "constraintDate": "2026-01-22"})
_, out = call("PATCH", f"/projects/{pid}/tasks/{ids['b']}",
              {"constraintType": "ASAP", "constraintDate": None})
check("releasing to ASAP pulls it back to the logic date",
      out["schedule"]["tasks"][ids["b"]]["earlyStart"] == "2026-01-15",
      out["schedule"]["tasks"][ids["b"]]["earlyStart"])

print("\n== actuals are fact ==")
call("PATCH", f"/projects/{pid}/tasks/{ids['a']}",
     {"actualStart": "2026-01-05", "actualFinish": "2026-01-16"})
_, out = call("POST", f"/projects/{pid}/what-if", {"tasks": [
    {"id": ids["a"], "constraintType": "START_NO_EARLIER_THAN", "constraintDate": "2026-01-20"}]})
check("no constraint can move a completed task",
      out["schedule"]["tasks"][ids["a"]]["earlyStart"] == "2026-01-05",
      out["schedule"]["tasks"][ids["a"]]["earlyStart"])
_, sched = call("GET", f"/projects/{pid}/schedule")
check("completed task reports status complete",
      sched["schedule"]["tasks"][ids["a"]]["status"] == "complete")

print("\n== bad input is 422, not 500 ==")
status, out = call("PATCH", f"/projects/{pid}/tasks/{ids['b']}",
                   {"constraintType": "MUST_START_ON", "constraintDate": None})
check("constraint without a date is rejected cleanly", status == 422, f"got {status}")
status, out = call("POST", f"/projects/{pid}/dependencies", {
    "predecessorId": ids["b"], "successorId": ids["a"], "type": "FS"})
check("cycle rejected with 422", status == 422, f"got {status}")
status, out = call("POST", f"/projects/{pid}/dependencies", {
    "predecessorId": ids["a"], "successorId": ids["b"], "type": "FS"})
check("duplicate link rejected with 409", status == 409, f"got {status}")

print("\n== unlink and delete ==")
_, sched = call("GET", f"/projects/{pid}/schedule")
dep = next(d for d in sched["dependencies"] if d["successorId"] == ids["b"])
status, out = call("DELETE", f"/projects/{pid}/dependencies/{dep['id']}")
check("dependency deleted", status == 200, f"got {status}")
check("successor pulled back to project start",
      out["schedule"]["tasks"][ids["b"]]["earlyStart"] == "2026-01-05",
      out["schedule"]["tasks"][ids["b"]]["earlyStart"])

status, out = call("DELETE", f"/projects/{pid}/tasks/{ids['b']}")
check("task deleted", status == 200, f"got {status}")
check("deleted task gone from schedule", ids["b"] not in out["schedule"]["tasks"])
_, sched = call("GET", f"/projects/{pid}/schedule")
check("its links went with it",
      all(ids["b"] not in (d["predecessorId"], d["successorId"]) for d in sched["dependencies"]))

status, _ = call("DELETE", f"/projects/{pid}/tasks/{ids['b']}")
check("deleting a gone task is 404", status == 404, f"got {status}")

print("\n" + ("ALL EDITING CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
