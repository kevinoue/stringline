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

print("\n== renaming a project, and its printed title block ==")
# The title block is what a printed schedule is identified by in a site
# trailer: which job, and which revision. Kept on the project so it is not
# retyped on every print.
status, out = call("PATCH", f"/projects/{pid}", {"name": "West wing — phase 2"})
check("a project can be renamed", status == 200, f"got {status}")
check("and comes back renamed", out["project"]["name"] == "West wing — phase 2", str(out)[:90])

status, out = call("PATCH", f"/projects/{pid}",
                   {"printSubtitle": "Rev C — issued for construction"})
check("the title block subtitle saves", status == 200, f"got {status}")
check("and comes back",
      out["project"]["printSubtitle"] == "Rev C — issued for construction",
      str(out["project"].get("printSubtitle")))

status, out = call("PATCH", f"/projects/{pid}", {"printTitle": "  "})
check("a blank title clears the override rather than printing a gap",
      status == 200 and out["project"]["printTitle"] is None, str(out["project"].get("printTitle")))

_, sched = call("GET", f"/projects/{pid}/schedule")
check("the schedule payload carries the title block, so print cannot disagree",
      sched["project"]["printSubtitle"] == "Rev C — issued for construction",
      str(sched.get("project")))

status, _ = call("PATCH", f"/projects/{pid}", {"name": "   "})
check("a blank name is rejected", status == 400, f"got {status}")
status, _ = call("PATCH", f"/projects/{pid}", {})
check("an empty change is rejected", status == 400, f"got {status}")

# Dates are deliberately not editable here — changing them reschedules the
# project, which has to go through the routes that explain and log the move.
status, out = call("PATCH", f"/projects/{pid}", {"deadline": "2027-01-01"})
check("a date change is not silently accepted here", status == 400, f"got {status}")

print("\n== moving the whole project ==")
# The case this exists for: a template started on the wrong day. Project start
# was write-once until now, so the only remedy was to delete and start again.
_, tpl = call("GET", "/projects/templates")
closedown = next((t for t in tpl["templates"] if "closedown" in t["name"].lower()), None)
if closedown:
    _, made = call("POST", "/projects/from-template", {
        "templateId": closedown["id"], "name": "Winter closedown",
        "startDate": "2026-10-15"})
    cid = made["projectId"]

    _, before = call("GET", f"/projects/{cid}/schedule")
    first_before = min(t["earlyStart"] for t in before["schedule"]["tasks"].values())
    finish_before = before["schedule"]["projectFinish"]
    check("the template started on the date it was given",
          first_before == "2026-10-15", first_before)

    status, out = call("POST", f"/projects/{cid}/reschedule", {"startDate": "2026-10-26"})
    check("the project start can be moved", status == 200, f"got {status}")

    sched = out["schedule"]
    first_after = min(t["earlyStart"] for t in sched["tasks"].values())
    check("the first task moves to the new start",
          first_after == "2026-10-26", first_after)

    # The whole point of the question: does everything downstream follow?
    moved = sum(1 for tid, t in sched["tasks"].items()
                if t["earlyStart"] != before["schedule"]["tasks"][tid]["earlyStart"])
    check("and every task behind it moves too",
          moved == len(sched["tasks"]), f"{moved} of {len(sched['tasks'])} moved")

    check("so the finish moves with it",
          sched["projectFinish"] != finish_before,
          f"{finish_before} -> {sched['projectFinish']}")
    check("and the move is reported, not silent",
          out.get("finishMovedDays", 0) != 0, str(out.get("finishMovedDays")))

    # A task pinned to a date is pinned. Moving the project must not drag it.
    tasks = sorted(sched["tasks"].values(), key=lambda t: t["earlyStart"])
    pinned_id = tasks[-1]["id"]
    call("PATCH", f"/projects/{cid}/tasks/{pinned_id}",
         {"constraintType": "MUST_START_ON", "constraintDate": "2026-12-14"})
    _, pinned_before = call("GET", f"/projects/{cid}/schedule")
    was = pinned_before["schedule"]["tasks"][pinned_id]["earlyStart"]

    _, out2 = call("POST", f"/projects/{cid}/reschedule", {"startDate": "2026-11-02"})
    check("a task pinned to a date stays pinned when the project moves",
          out2["schedule"]["tasks"][pinned_id]["earlyStart"] == was,
          f"{was} -> {out2['schedule']['tasks'][pinned_id]['earlyStart']}")

    status, _ = call("POST", f"/projects/{cid}/reschedule", {"startDate": "26th October"})
    check("a malformed date is rejected", status == 400, f"got {status}")
    status, _ = call("POST", f"/projects/{cid}/reschedule", {})
    check("an empty reschedule is rejected", status == 400, f"got {status}")

    status, out = call("PATCH", f"/projects/{cid}", {"startDate": "2026-11-02"})
    check("PATCH points at the right route instead of refusing blankly",
          status == 400 and out.get("code") == "USE_RESCHEDULE", str(out)[:90])

    _, hist = call("GET", f"/projects/{cid}/history")
    check("moving the project is in the change log",
          any(h["action"] == "project.start" for h in hist.get("history", [])),
          str([h["action"] for h in hist.get("history", [])][:4]))
else:
    print("  SKIP  no closedown template to move")

print("\n" + ("ALL EDITING CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
