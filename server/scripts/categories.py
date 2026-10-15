"""
Categories — the trade, department or crew a task belongs to.

Phases answer *when* in the job. This answers *who*, and the two cut across
each other: the same sparky appears in first fix and again in finishes.

Two rules are worth protecting here. **Categories are company-scoped**, so a
second project reuses "Electrical" rather than minting a duplicate — that is
what keeps a chart's colours meaning the same thing from one job to the next.
And **deleting a category leaves its work alive**, untagged, exactly as
deleting a phase does.
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


slug = f"cat{random.randint(10000, 99999)}"
_, o = call("POST", "/auth/signup", {
    "companyName": "Trade Co", "slug": slug,
    "email": "owner@trade.test", "password": "correcthorse", "name": "Owner"})
owner = o["token"]

print("\n== a new company has none, and a word for them ==")
st, o = call("GET", "/categories", None, owner)
check("the list is readable", st == 200, f"got {st}")
check("and is empty to start", o.get("categories") == [], str(o.get("categories")))
check("the palette comes with it", len(o.get("palette", [])) >= 8, f"{len(o.get('palette', []))} colours")
check("red is not in the palette — the critical path owns it",
      not any(c["key"] in ("red", "crimson", "scarlet") for c in o["palette"]),
      str([c["key"] for c in o["palette"]]))
check("and a default word for the dimension", o.get("label") == "Trade", str(o.get("label")))

print("\n== naming the dimension ==")
st, o = call("PUT", "/categories/label", {"label": "Department"}, owner)
check("a hotel can call them departments", st == 200, f"got {st}")
check("and it sticks", call("GET", "/categories", None, owner)[1]["label"] == "Department")
st, _ = call("PUT", "/categories/label", {"label": "   "}, owner)
check("a blank label is rejected", st == 400, f"got {st}")
call("PUT", "/categories/label", {"label": "Trade"}, owner)

print("\n== creating ==")
st, o = call("POST", "/categories", {"name": "  Electrical  "}, owner)
check("a category can be created", st == 201, f"got {st} {str(o)[:90]}")
electrical = (o or {}).get("category", {})
check("the name is trimmed", electrical.get("name") == "Electrical", str(electrical.get("name")))
check("a colour is chosen for you", bool(electrical.get("colour")), str(electrical.get("colour")))

st, o = call("POST", "/categories", {"name": "Plumbing", "description": "First and second fix"}, owner)
plumbing = o["category"]
check("colours are handed out in palette order, not repeated",
      plumbing["colour"] != electrical["colour"],
      f"{electrical['colour']} vs {plumbing['colour']}")
check("a description can be given", plumbing["description"] == "First and second fix",
      str(plumbing.get("description")))

st, _ = call("POST", "/categories", {"name": "Electrical"}, owner)
check("the same name twice is refused", st == 409, f"got {st}")
st, _ = call("POST", "/categories", {"name": "   "}, owner)
check("a blank name is refused", st == 400, f"got {st}")
st, _ = call("POST", "/categories", {"name": "Neon", "colour": "hotpink"}, owner)
check("a colour outside the palette is refused", st == 400, f"got {st}")

print("\n== tagging tasks ==")
_, o = call("POST", "/projects", {"name": "Fit-out", "startDate": "2026-11-02"}, owner)
pid = o["project"]["id"]
_, o = call("POST", f"/projects/{pid}/tasks", {"name": "Rough-in", "durationDays": 5}, owner)
rough = o["taskId"]
_, o = call("POST", f"/projects/{pid}/tasks", {"name": "Second fix", "durationDays": 3}, owner)
second = o["taskId"]

st, _ = call("PATCH", f"/projects/{pid}/tasks/{rough}", {"categoryId": electrical["id"]}, owner)
check("a task can be tagged", st == 200, f"got {st}")
call("PATCH", f"/projects/{pid}/tasks/{second}", {"categoryId": electrical["id"]}, owner)

_, o = call("GET", f"/projects/{pid}/schedule", None, owner)
by_id = {d["id"]: d for d in o["details"]}
check("the tag comes back on the task",
      by_id[rough]["categoryId"] == electrical["id"], str(by_id[rough].get("categoryId")))
check("and the schedule carries the categories it uses",
      [c["name"] for c in o["categories"]] == ["Electrical"], str(o.get("categories")))
check("only the ones this project uses, not the whole company list",
      len(o["categories"]) == 1, f"{len(o['categories'])} of 2 company categories")

_, o = call("GET", "/categories", None, owner)
counts = {c["name"]: c["taskCount"] for c in o["categories"]}
check("the company list counts tagged tasks", counts.get("Electrical") == 2, str(counts))
check("and shows zero for unused ones", counts.get("Plumbing") == 0, str(counts))

st, _ = call("PATCH", f"/projects/{pid}/tasks/{second}", {"categoryId": None}, owner)
check("a task can be untagged again", st == 200, f"got {st}")

print("\n== renaming and recolouring ==")
st, o = call("PATCH", f"/categories/{plumbing['id']}", {"name": "Mechanical", "colour": "indigo"}, owner)
check("a category can be renamed and recoloured", st == 200, f"got {st}")
check("and comes back changed",
      o["category"]["name"] == "Mechanical" and o["category"]["colour"] == "indigo", str(o["category"]))
st, _ = call("PATCH", f"/categories/{plumbing['id']}", {"name": "Electrical"}, owner)
check("renaming onto an existing name is refused", st == 409, f"got {st}")
st, _ = call("PATCH", f"/categories/{plumbing['id']}", {}, owner)
check("an empty change is refused", st == 400, f"got {st}")
st, _ = call("PATCH", f"/categories/{plumbing['id']}", {"colour": "taupe"}, owner)
check("an unknown colour is refused", st == 400, f"got {st}")

print("\n== deleting a category keeps its work ==")
st, o = call("DELETE", f"/categories/{electrical['id']}", None, owner)
check("a category can be deleted", st == 200, f"got {st}")
check("and says how many tasks it untagged", (o or {}).get("untaggedTasks") == 1, str(o))

_, o = call("GET", f"/projects/{pid}/schedule", None, owner)
check("THE TASKS SURVIVE", len(o["details"]) == 2, f"{len(o['details'])} tasks")
check("they are simply untagged",
      all(d["categoryId"] is None for d in o["details"]), str([d["categoryId"] for d in o["details"]]))
check("and the project lists no categories now", o["categories"] == [], str(o["categories"]))

st, _ = call("DELETE", f"/categories/{electrical['id']}", None, owner)
check("deleting twice is a 404, not a crash", st == 404, f"got {st}")

print("\n== templates arrive tagged ==")
_, o = call("GET", "/projects/templates", None, owner)
closedown = next((t for t in o["templates"] if "closedown" in t["name"].lower()), None)
if closedown:
    _, made = call("POST", "/projects/from-template",
                   {"templateId": closedown["id"], "name": "Closedown",
                    "startDate": "2026-10-26"}, owner)
    _, sched = call("GET", f"/projects/{made['projectId']}/schedule", None, owner)
    names = sorted(c["name"] for c in sched["categories"])
    check("a template project arrives already tagged", len(names) >= 5, str(names))
    tagged = sum(1 for d in sched["details"] if d["categoryId"])
    check("and nearly every task carries one",
          tagged >= len(sched["details"]) - 2, f"{tagged} of {len(sched['details'])}")
    check("every category gets a distinct colour",
          len({c["colour"] for c in sched["categories"]}) == len(sched["categories"]),
          str([c["colour"] for c in sched["categories"]]))

    # The company-scoped rule: a second job reuses the same categories, which
    # is what makes a colour mean the same thing from one chart to the next.
    before = len(call("GET", "/categories", None, owner)[1]["categories"])
    call("POST", "/projects/from-template",
         {"templateId": closedown["id"], "name": "Closedown 2", "startDate": "2027-10-26"}, owner)
    after = len(call("GET", "/categories", None, owner)[1]["categories"])
    check("a second project from the same template reuses them, not duplicates",
          after == before, f"{before} -> {after}")
else:
    print("  SKIP  no closedown template found")

print("\n== permissions and isolation ==")
_, o = call("POST", "/team/invites", {"email": "hand@trade.test", "role": "field"}, owner)
_, o = call("POST", f"/team/invites/{o['invite']['token']}/accept", {"password": "fieldpassword"})
field = o["token"]

st, _ = call("POST", "/categories", {"name": "Sneaky"}, field)
check("a field user cannot create one", st == 403, f"got {st}")
st, _ = call("PATCH", f"/categories/{plumbing['id']}", {"name": "Nope"}, field)
check("nor rename one", st == 403, f"got {st}")
st, _ = call("DELETE", f"/categories/{plumbing['id']}", None, field)
check("nor delete one", st == 403, f"got {st}")
st, _ = call("PUT", "/categories/label", {"label": "Nope"}, field)
check("nor rename the dimension", st == 403, f"got {st}")
check("but they can see them", call("GET", "/categories", None, field)[0] == 200)

other = f"oth{random.randint(10000, 99999)}"
_, o = call("POST", "/auth/signup", {
    "companyName": "Other", "slug": other,
    "email": "o@other.test", "password": "correcthorse", "name": "O"})
outsider = o["token"]

st, o = call("GET", "/categories", None, outsider)
check("another company sees none of ours", o.get("categories") == [], str(o.get("categories"))[:80])
st, _ = call("PATCH", f"/categories/{plumbing['id']}", {"name": "Theirs"}, outsider)
check("and cannot rename ours", st == 404, f"got {st}")
st, _ = call("DELETE", f"/categories/{plumbing['id']}", None, outsider)
check("nor delete ours", st == 404, f"got {st}")

# Tagging with a stranger's category would leak a name and a colour across the
# company boundary, so the foreign key alone is not enough — it has to be
# rejected rather than quietly stored.
_, o = call("POST", "/projects", {"name": "Theirs", "startDate": "2026-11-02"}, outsider)
their_pid = o["project"]["id"]
_, o = call("POST", f"/projects/{their_pid}/tasks", {"name": "X", "durationDays": 1}, outsider)
st, _ = call("PATCH", f"/projects/{their_pid}/tasks/{o['taskId']}",
             {"categoryId": plumbing["id"]}, outsider)
check("and cannot tag their task with our category", st in (400, 403, 404, 422), f"got {st}")

print("\n" + ("ALL CATEGORY CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
