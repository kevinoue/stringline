"""
The three drag gestures, end to end.

Kevin's spec, 2026-09-15: grab the centre to slide it, the left end to change
the start, the right end to change the finish or duration — with dependency
rules still enforced and an impossible move shown as blocked.

These assert what each gesture resolves to, including on work that has already
started, where a drag edits the recorded actuals rather than the plan.
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


def preview(pid, tid, mode, target):
    return call("POST", f"/projects/{pid}/tasks/{tid}/preview-move",
                {"mode": mode, "targetDate": target})[1]


slug = f"drag-{random.randint(10000, 99999)}"
_, o = call("POST", "/auth/signup", {
    "companyName": "Drag Co", "slug": slug,
    "email": "d@drag.test", "password": "correcthorse", "name": "Dragger"})
TOKEN = o["token"]
_, o = call("POST", "/projects", {"name": "Drag", "startDate": "2026-01-05"})
pid = o["project"]["id"]

ids = {}
for key, name, days in [("a", "Excavate", 5), ("b", "Foundation", 5), ("c", "Frame", 5)]:
    ids[key] = call("POST", f"/projects/{pid}/tasks", {"name": name, "durationDays": days})[1]["taskId"]
for p_, s_ in [("a", "b"), ("b", "c")]:
    call("POST", f"/projects/{pid}/dependencies",
         {"predecessorId": ids[p_], "successorId": ids[s_], "type": "FS"})

_, sc = call("GET", f"/projects/{pid}/schedule")
t = sc["schedule"]["tasks"]
print(f"\n  plan: Excavate {t[ids['a']]['earlyStart']}..{t[ids['a']]['earlyFinish']}, "
      f"Foundation {t[ids['b']]['earlyStart']}..{t[ids['b']]['earlyFinish']}")

print("\n== centre drag: slide, duration unchanged ==")
p = preview(pid, ids["b"], "move", "2026-01-19")
check("allowed", p["allowed"], p.get("reason", ""))
check("writes a start constraint", p["patch"].get("constraintType") == "START_NO_EARLIER_THAN")
check("does not change duration", "durationDays" not in p["patch"])
check("pushes the finish out", p["hypotheticalFinish"] > p["currentFinish"],
      f"{p['currentFinish']} -> {p['hypotheticalFinish']}")

print("\n== right edge: change the finish, so duration changes ==")
p = preview(pid, ids["b"], "resize-end", "2026-01-23")
check("allowed", p["allowed"], p.get("reason", ""))
# Foundation starts 01-12; through 01-23 inclusive is 10 working days.
check("duration recomputed on the calendar", p["patch"].get("durationDays") == 10,
      str(p["patch"].get("durationDays")))
check("start untouched", "constraintDate" not in p["patch"] or p["patch"]["constraintDate"] is None)

print("\n== left edge: change the start, finish held ==")
p = preview(pid, ids["b"], "resize-start", "2026-01-14")
check("allowed", p["allowed"], p.get("reason", ""))
check("start constraint written", p["patch"].get("constraintDate") == "2026-01-14")
# 01-14 through 01-16 inclusive is 3 working days.
check("duration shrinks to match", p["patch"].get("durationDays") == 3,
      str(p["patch"].get("durationDays")))

print("\n== dependency rules still bite ==")
p = preview(pid, ids["b"], "move", "2026-01-06")
check("dragging before a predecessor is refused", not p["allowed"])
check("and names the blocker", "Excavate" in (p.get("reason") or ""), p.get("reason", ""))
check("floor reported for the shaded zone", p["earliestStart"] == "2026-01-12", p["earliestStart"])

print("\n== dragging back to the floor releases the constraint ==")
call("PATCH", f"/projects/{pid}/tasks/{ids['b']}",
     {"constraintType": "START_NO_EARLIER_THAN", "constraintDate": "2026-01-19"})
p = preview(pid, ids["b"], "move", "2026-01-12")
check("resolves to ASAP, not a redundant constraint", p["patch"].get("constraintType") == "ASAP",
      str(p["patch"]))
call("PATCH", f"/projects/{pid}/tasks/{ids['b']}", {"constraintType": "ASAP", "constraintDate": None})

print("\n== work with actuals is edited through its actuals ==")
call("PATCH", f"/projects/{pid}/tasks/{ids['a']}",
     {"actualStart": "2026-01-05", "actualFinish": "2026-01-09"})
p = preview(pid, ids["a"], "resize-end", "2026-01-13")
check("right edge corrects the actual finish", p["patch"].get("actualFinish") == "2026-01-13",
      str(p["patch"]))
check("completed work is draggable again, not refused", p["allowed"])
p = preview(pid, ids["a"], "move", "2026-01-06")
check("centre drag shifts both recorded dates",
      p["patch"].get("actualStart") == "2026-01-06" and p["patch"].get("actualFinish") == "2026-01-12",
      str(p["patch"]))

call("PATCH", f"/projects/{pid}/tasks/{ids['a']}",
     {"actualFinish": None, "percentComplete": 40})
p = preview(pid, ids["a"], "resize-end", "2026-01-15")
check("in-progress right edge sets remaining days", "remainingDays" in p["patch"], str(p["patch"]))

print("\n== the preview says what will and will not move ==")
# Kevin dragged a completed first task and got an orphaned bar in the middle of
# the chart with no explanation. The move was correct; the silence was not.
call("PATCH", f"/projects/{pid}/tasks/{ids['a']}",
     {"actualStart": "2026-01-05", "actualFinish": "2026-01-09"})
call("PATCH", f"/projects/{pid}/tasks/{ids['b']}",
     {"actualStart": "2026-01-12", "actualFinish": "2026-01-16"})
p = preview(pid, ids["a"], "move", "2026-02-02")
check("a move with no followers says so", any("Nothing else moves" in w for w in p.get("warnings", [])),
      str(p.get("warnings")))
check("and reports nothing affected", p.get("affected") == [], str(p.get("affected")))
check("and names the pinned successor", any("Foundation" in w for w in p.get("warnings", [])),
      str(p.get("warnings")))
p2 = preview(pid, ids["a"], "resize-end", "2026-01-30")
check("a recorded date past a successor's recorded start is flagged",
      any("recorded as starting" in w for w in p2.get("warnings", [])), str(p2.get("warnings")))

# A normal forecast move should report its followers instead.
call("PATCH", f"/projects/{pid}/tasks/{ids['a']}",
     {"actualStart": None, "actualFinish": None})
call("PATCH", f"/projects/{pid}/tasks/{ids['b']}",
     {"actualStart": None, "actualFinish": None})
p3 = preview(pid, ids["a"], "move", "2026-01-19")
check("a forecast move lists what moves with it", len(p3.get("affected", [])) >= 2,
      str(p3.get("affected")))
check("and raises no warning", p3.get("warnings") == [], str(p3.get("warnings")))

print("\n== nonsense is refused ==")
call("PATCH", f"/projects/{pid}/tasks/{ids['a']}",
     {"actualStart": None, "actualFinish": None, "percentComplete": None})
p = preview(pid, ids["b"], "resize-end", "2026-01-05")
check("a bar cannot be dragged to zero length", not p["allowed"], p.get("reason", ""))

_, o = call("POST", f"/projects/{pid}/tasks", {"name": "Gate", "durationDays": 0})
p = preview(pid, o["taskId"], "resize-end", "2026-02-01")
check("a milestone cannot be resized", not p["allowed"], p.get("reason", ""))

status, _ = call("POST", f"/projects/{pid}/tasks/{ids['b']}/preview-move", {"mode": "nonsense"})
check("bad mode is a 400", status == 400, f"got {status}")

print("\n" + ("ALL DRAG CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
