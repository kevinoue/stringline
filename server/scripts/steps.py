"""
Steps — the parts of a task, in order.

A step is contained by its task: no dependencies, no constraints, dates
derived from where the task landed. That containment is the design, and the
thing worth protecting. The solver never sees a step, which is why this
feature cannot break scheduling.

But steps are not inert. A step's duration is part of its task's duration, so
lengthening one moves everything downstream — the same cascade a slip in one
department causes. That is the single most important check here.
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


slug = f"st{random.randint(10000, 99999)}"
_, o = call("POST", "/auth/signup", {
    "companyName": "Step Co", "slug": slug,
    "email": "owner@step.test", "password": "correcthorse", "name": "Owner"})
owner = o["token"]

# 2026-11-02 is a Monday, so the week boundary is predictable.
_, o = call("POST", "/projects", {"name": "Closedown", "startDate": "2026-11-02"}, owner)
pid = o["project"]["id"]
_, o = call("POST", f"/projects/{pid}/tasks", {"name": "Winterise pool", "durationDays": 2}, owner)
pool = o["taskId"]
_, o = call("POST", f"/projects/{pid}/tasks", {"name": "Shut off water", "durationDays": 1}, owner)
water = o["taskId"]
call("POST", f"/projects/{pid}/dependencies",
     {"predecessorId": pool, "successorId": water, "type": "FS"}, owner)


def schedule():
    _, s = call("GET", f"/projects/{pid}/schedule", None, owner)
    return s


print("\n== a task with no steps is unchanged ==")
s = schedule()
check("the payload carries a steps list", "steps" in s, str(list(s.keys())))
check("and it is empty", s["steps"] == [], str(s["steps"]))
check("the task keeps the duration it was given",
      s["schedule"]["tasks"][pool]["durationDays"] == 2,
      str(s["schedule"]["tasks"][pool]["durationDays"]))

print("\n== a tick-list does not change how long anything takes ==")
# Four zero-day checks. A checklist describes how work is done, not how long
# it takes — overwriting a two-day task with zero would be a nasty surprise.
for name in ["Drain the pool", "Blow out the lines", "Add antifreeze", "Fit the cover"]:
    st, _ = call("POST", f"/projects/{pid}/tasks/{pool}/steps", {"name": name}, owner)
s = schedule()
check("four checks were added", len(s["steps"]) == 4, f"{len(s['steps'])} steps")
check("the task's duration is untouched",
      s["schedule"]["tasks"][pool]["durationDays"] == 2,
      str(s["schedule"]["tasks"][pool]["durationDays"]))
check("every check is marked as one, not a bar",
      all(x["isCheck"] for x in s["steps"]), str([x["isCheck"] for x in s["steps"]]))
check("and they all sit on the task's first day",
      all(x["start"] == s["schedule"]["tasks"][pool]["earlyStart"] for x in s["steps"]),
      str({x["name"]: x["start"] for x in s["steps"]}))

print("\n== ticking steps off rolls up ==")
ids = {x["name"]: x["id"] for x in s["steps"]}
call("PATCH", f"/projects/{pid}/tasks/{pool}/steps/{ids['Drain the pool']}",
     {"actualStart": "2026-11-02", "actualFinish": "2026-11-02"}, owner)
s = schedule()
check("one of four done reads as 25%",
      s["details"][0]["percentComplete"] == 25 or
      next(d for d in s["details"] if d["id"] == pool)["percentComplete"] == 25,
      str(next(d for d in s["details"] if d["id"] == pool)["percentComplete"]))

call("PATCH", f"/projects/{pid}/tasks/{pool}/steps/{ids['Blow out the lines']}",
     {"actualStart": "2026-11-02"}, owner)
s = schedule()
check("a started step counts half",
      next(d for d in s["details"] if d["id"] == pool)["percentComplete"] == 38,
      str(next(d for d in s["details"] if d["id"] == pool)["percentComplete"]))
check("the task is under way once any step is",
      next(d for d in s["details"] if d["id"] == pool)["actualStart"] == "2026-11-02",
      str(next(d for d in s["details"] if d["id"] == pool)["actualStart"]))
check("but not finished while steps remain",
      next(d for d in s["details"] if d["id"] == pool)["actualFinish"] is None,
      str(next(d for d in s["details"] if d["id"] == pool)["actualFinish"]))

print("\n== steps with durations make up the task ==")
_, o = call("POST", "/projects", {"name": "Build", "startDate": "2026-11-02"}, owner)
p2 = o["project"]["id"]
_, o = call("POST", f"/projects/{p2}/tasks", {"name": "Rough-in", "durationDays": 1}, owner)
rough = o["taskId"]
_, o = call("POST", f"/projects/{p2}/tasks", {"name": "Inspection", "durationDays": 1}, owner)
inspect = o["taskId"]
call("POST", f"/projects/{p2}/dependencies",
     {"predecessorId": rough, "successorId": inspect, "type": "FS"}, owner)

_, before = call("GET", f"/projects/{p2}/schedule", None, owner)
inspect_before = before["schedule"]["tasks"][inspect]["earlyStart"]

for name, days in [("Panel", 2), ("Ground floor", 3), ("First floor", 2)]:
    call("POST", f"/projects/{p2}/tasks/{rough}/steps", {"name": name, "durationDays": days}, owner)

_, s2 = call("GET", f"/projects/{p2}/schedule", None, owner)
check("the task's duration becomes the sum of its steps",
      s2["schedule"]["tasks"][rough]["durationDays"] == 7,
      str(s2["schedule"]["tasks"][rough]["durationDays"]))

steps = sorted([x for x in s2["steps"] if x["taskId"] == rough], key=lambda x: x["sortOrder"])
check("the first step starts where the task starts",
      steps[0]["start"] == s2["schedule"]["tasks"][rough]["earlyStart"],
      f"{steps[0]['start']} vs {s2['schedule']['tasks'][rough]['earlyStart']}")
check("a two-day step starts and finishes on consecutive working days",
      (steps[0]["start"], steps[0]["finish"]) == ("2026-11-02", "2026-11-03"),
      f"{steps[0]['start']} -> {steps[0]['finish']}")
check("the next step picks up where the last one left off",
      steps[1]["start"] == "2026-11-04", steps[1]["start"])
check("and the sequence skips the weekend",
      steps[2]["start"] == "2026-11-09" and steps[2]["finish"] == "2026-11-10",
      f"{steps[2]['start']} -> {steps[2]['finish']}")
check("the last step ends when the task does",
      steps[-1]["finish"] == s2["schedule"]["tasks"][rough]["earlyFinish"],
      f"{steps[-1]['finish']} vs {s2['schedule']['tasks'][rough]['earlyFinish']}")

print("\n== THE ONE THAT MATTERS: a step's duration moves the schedule ==")
check("adding steps already pushed the dependent task",
      s2["schedule"]["tasks"][inspect]["earlyStart"] != inspect_before,
      f"{inspect_before} -> {s2['schedule']['tasks'][inspect]['earlyStart']}")

was = s2["schedule"]["tasks"][inspect]["earlyStart"]
st, out = call("PATCH", f"/projects/{p2}/tasks/{rough}/steps/{steps[0]['id']}",
               {"durationDays": 5}, owner)
check("lengthening a step is accepted", st == 200, f"got {st}")
check("the task grew with it", out["schedule"]["tasks"][rough]["durationDays"] == 10,
      str(out["schedule"]["tasks"][rough]["durationDays"]))
check("and everything downstream moved",
      out["schedule"]["tasks"][inspect]["earlyStart"] != was,
      f"{was} -> {out['schedule']['tasks'][inspect]['earlyStart']}")
check("the move is reported, not silent", out.get("finishMovedDays", 0) == 3,
      str(out.get("finishMovedDays")))

print("\n== reordering and removing ==")
_, s2 = call("GET", f"/projects/{p2}/schedule", None, owner)
steps = sorted([x for x in s2["steps"] if x["taskId"] == rough], key=lambda x: x["sortOrder"])
flipped = [steps[2]["id"], steps[1]["id"], steps[0]["id"]]
st, _ = call("PUT", f"/projects/{p2}/tasks/{rough}/steps/order", {"order": flipped}, owner)
check("steps can be reordered in one request", st == 204, f"got {st}")

_, s2 = call("GET", f"/projects/{p2}/schedule", None, owner)
reordered = sorted([x for x in s2["steps"] if x["taskId"] == rough], key=lambda x: x["sortOrder"])
check("the order changed", reordered[0]["name"] == steps[2]["name"],
      f"{reordered[0]['name']} first")
check("and the dates reflowed to match",
      reordered[0]["start"] == s2["schedule"]["tasks"][rough]["earlyStart"],
      reordered[0]["start"])
check("but the task's duration is the same — order does not change how long it takes",
      s2["schedule"]["tasks"][rough]["durationDays"] == 10,
      str(s2["schedule"]["tasks"][rough]["durationDays"]))

st, out = call("DELETE", f"/projects/{p2}/tasks/{rough}/steps/{reordered[0]['id']}", None, owner)
check("a step can be deleted", st == 200, f"got {st}")
check("and the task shortens by that much",
      out["schedule"]["tasks"][rough]["durationDays"] == 10 - reordered[0]["durationDays"],
      str(out["schedule"]["tasks"][rough]["durationDays"]))

print("\n== refusals ==")
st, _ = call("POST", f"/projects/{p2}/tasks/{rough}/steps", {"name": "   "}, owner)
check("a blank name is refused", st == 400, f"got {st}")
st, o = call("POST", f"/projects/{p2}/tasks/{rough}/steps",
             {"name": "Half a day", "durationDays": 0.5}, owner)
check("a fractional duration is refused", st == 400, f"got {st}")
check("and says what is allowed", "whole number" in (o.get("error") or ""), o.get("error", ""))
st, _ = call("POST", f"/projects/{p2}/tasks/{rough}/steps",
             {"name": "Negative", "durationDays": -1}, owner)
check("a negative duration is refused", st == 400, f"got {st}")
st, _ = call("PUT", f"/projects/{p2}/tasks/{rough}/steps/order", {"order": []}, owner)
check("an empty order is refused", st == 400, f"got {st}")

print("\n== adding a step never deletes a recorded date ==")
# An actual is a record of something that happened. Deriving the parent's
# actuals unconditionally meant adding a step to a finished task wiped its
# finish date, because no step had been ticked yet.
_, o = call("POST", f"/projects/{p2}/tasks", {"name": "Already finished", "durationDays": 2}, owner)
done_task = o["taskId"]
call("PATCH", f"/projects/{p2}/tasks/{done_task}",
     {"actualStart": "2026-11-02", "actualFinish": "2026-11-03"}, owner)
_, s2 = call("GET", f"/projects/{p2}/schedule", None, owner)
before = next(d for d in s2["details"] if d["id"] == done_task)
check("the task is recorded as finished", before["actualFinish"] == "2026-11-03",
      str(before["actualFinish"]))

call("POST", f"/projects/{p2}/tasks/{done_task}/steps", {"name": "A step added later"}, owner)
_, s2 = call("GET", f"/projects/{p2}/schedule", None, owner)
after = next(d for d in s2["details"] if d["id"] == done_task)
check("adding an untouched step leaves the recorded dates alone",
      after["actualFinish"] == "2026-11-03" and after["actualStart"] == "2026-11-02",
      f"{after['actualStart']} → {after['actualFinish']}")

# But once a step is reported, the roll-up takes over.
_, s2 = call("GET", f"/projects/{p2}/schedule", None, owner)
new_step = next(x for x in s2["steps"] if x["taskId"] == done_task)
call("PATCH", f"/projects/{p2}/tasks/{done_task}/steps/{new_step['id']}",
     {"actualStart": "2026-11-05"}, owner)
_, s2 = call("GET", f"/projects/{p2}/schedule", None, owner)
rolled = next(d for d in s2["details"] if d["id"] == done_task)
check("but once a step is reported, the roll-up takes over",
      rolled["actualFinish"] is None, str(rolled["actualFinish"]))

print("\n== deleting the task takes its steps ==")
_, o = call("POST", f"/projects/{p2}/tasks", {"name": "Doomed", "durationDays": 1}, owner)
doomed = o["taskId"]
call("POST", f"/projects/{p2}/tasks/{doomed}/steps", {"name": "Goes too", "durationDays": 1}, owner)
call("DELETE", f"/projects/{p2}/tasks/{doomed}", None, owner)
_, s2 = call("GET", f"/projects/{p2}/schedule", None, owner)
check("the steps went with it",
      not any(x["taskId"] == doomed for x in s2["steps"]),
      str([x["name"] for x in s2["steps"] if x["taskId"] == doomed]))

print("\n== who may do what ==")
_, o = call("POST", "/team/invites", {"email": "hand@step.test", "role": "field"}, owner)
_, o = call("POST", f"/team/invites/{o['invite']['token']}/accept", {"password": "fieldpassword"})
field = o["token"]

_, s2 = call("GET", f"/projects/{p2}/schedule", None, field)
live = [x for x in s2["steps"] if x["taskId"] == rough][0]

st, _ = call("POST", f"/projects/{p2}/tasks/{rough}/steps", {"name": "Sneaky"}, field)
check("a field user cannot add a step", st == 403, f"got {st}")
st, _ = call("PATCH", f"/projects/{p2}/tasks/{rough}/steps/{live['id']}",
             {"durationDays": 9}, field)
check("nor change how long one takes", st == 403, f"got {st}")
st, _ = call("DELETE", f"/projects/{p2}/tasks/{rough}/steps/{live['id']}", None, field)
check("nor delete one", st == 403, f"got {st}")

# But recording what happened is exactly their job.
st, _ = call("PATCH", f"/projects/{p2}/tasks/{rough}/steps/{live['id']}",
             {"actualStart": "2026-11-02"}, field)
check("but they CAN tick one off — that is the point of the field role",
      st == 200, f"got {st}")

print("\n== companies stay separate ==")
other = f"oth{random.randint(10000, 99999)}"
_, o = call("POST", "/auth/signup", {
    "companyName": "Other", "slug": other,
    "email": "o@other.test", "password": "correcthorse", "name": "O"})
outsider = o["token"]
st, _ = call("POST", f"/projects/{p2}/tasks/{rough}/steps", {"name": "Theirs"}, outsider)
check("another company cannot add a step to our task", st == 404, f"got {st}")
st, _ = call("PATCH", f"/projects/{p2}/tasks/{rough}/steps/{live['id']}", {"name": "X"}, outsider)
check("nor rename ours", st == 404, f"got {st}")
st, _ = call("DELETE", f"/projects/{p2}/tasks/{rough}/steps/{live['id']}", None, outsider)
check("nor delete ours", st == 404, f"got {st}")

print("\n== steps survive being saved as a template ==")
st, o = call("POST", f"/projects/{p2}/save-as-template",
             {"name": f"With steps {random.randint(100, 999)}", "category": "test"}, owner)
check("the project saves as a template", st == 201, f"got {st}")
tpl = o["templateId"]
st, made = call("POST", "/projects/from-template",
                {"templateId": tpl, "name": "From template", "startDate": "2026-12-07"}, owner)
check("and a project can be made from it", st == 201, f"got {st}")
_, s3 = call("GET", f"/projects/{made['projectId']}/schedule", None, owner)
check("the steps came through", len(s3["steps"]) > 0, f"{len(s3['steps'])} steps")
rough_again = next((d for d in s3["details"]
                    if next(t for t in s3["schedule"]["tasks"].values()
                            if t["id"] == d["id"])["name"] == "Rough-in"), None)
if rough_again:
    check("and the task's duration still matches its steps",
          s3["schedule"]["tasks"][rough_again["id"]]["durationDays"]
          == sum(x["durationDays"] for x in s3["steps"]
                 if x["taskId"] == rough_again["id"]),
          str(s3["schedule"]["tasks"][rough_again["id"]]["durationDays"]))

print("\n" + ("ALL STEP CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
