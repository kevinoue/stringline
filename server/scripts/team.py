"""
Teams: invites, roles, and the two ways a password gets recovered.

The thing this suite is really guarding is that **none of it depends on email.**
Stringline's whole pitch is free unlimited field and client seats, and anyone
self-hosting it from GitHub has no Resend account. If adding a second person
needs working mail, the promise is not real.

So every check below passes with RESEND_API_KEY unset. Run it a second time
with a key set to confirm the email path also works:

    python3 scripts/team.py
    RESEND_API_KEY=re_... python3 scripts/team.py
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


slug = f"team{random.randint(10000, 99999)}"
PW = "correcthorse"
_, o = call("POST", "/auth/signup", {
    "companyName": "Team Co", "slug": slug,
    "email": "owner@team.test", "password": PW, "name": "Olivia Owner"})
owner = o["token"]

print("\n== a new company is a team of one ==")
st, o = call("GET", "/team", None, owner)
check("the team is readable", st == 200, f"got {st}")
check("and has exactly the owner in it", len(o.get("members", [])) == 1, str(o)[:120])
check("with no invites pending", o.get("invites") == [])
check("one billable seat used", o.get("seatsUsed") == 1, str(o.get("seatsUsed")))
EMAIL_ON = o.get("emailEnabled")
print(f"  (email is {'configured' if EMAIL_ON else 'NOT configured — the important case'})")

print("\n== inviting ==")
st, o = call("POST", "/team/invites",
             {"email": "Field.Guy@Team.test", "role": "field", "name": "Frank Field"}, owner)
check("an invite is created", st == 201, f"got {st} {str(o)[:120]}")
invite = (o or {}).get("invite", {})
code = invite.get("token")
check("it comes back with a code", bool(code), str(invite)[:120])
check("and a link that can be copied", (invite.get("url") or "").find(code or "x") > 0,
      invite.get("url", ""))
check("the email is normalised", invite.get("email") == "field.guy@team.test", str(invite.get("email")))
check("it records who sent it", invite.get("invited_by") == "Olivia Owner", str(invite.get("invited_by")))
check("the response says whether mail went out", "emailed" in (o or {}), str(o)[:80])
if not EMAIL_ON:
    check("with no key, nothing was emailed — and that is fine", o.get("emailed") is False)

st, o = call("POST", "/team/invites", {"email": "field.guy@team.test", "role": "field"}, owner)
check("the same address cannot be invited twice while one is pending", st == 409, f"got {st}")

st, _ = call("POST", "/team/invites", {"email": "x@team.test", "role": "wizard"}, owner)
check("an unknown role is rejected", st == 400, f"got {st}")

st, _ = call("POST", "/team/invites", {"email": "x@team.test"}, owner)
check("a missing role is rejected", st == 400, f"got {st}")

print("\n== an invite is worth something before it is used ==")
st, o = call("GET", f"/team/invites/{code}/validate")
check("a code validates without a login", st == 200, f"got {st}")
check("and names the company being joined", o.get("companyName") == "Team Co", str(o))
check("and the role on offer", o.get("role") == "field", str(o))
check("and the company code to sign in with", o.get("slug") == slug, str(o))

st, o = call("GET", "/team/invites/AAA-BBB-CCC/validate")
check("a made-up code does not validate", st == 404, f"got {st}")

print("\n== accepting ==")
st, o = call("POST", f"/team/invites/{code}/accept", {"password": "short"})
check("a short password is rejected", st == 400, f"got {st}")

st, o = call("POST", f"/team/invites/{code}/accept",
             {"password": "fieldpassword", "name": "Frank Field"})
check("the invite is accepted", st == 201, f"got {st} {str(o)[:120]}")
field = (o or {}).get("token")
check("and they are signed in straight away", bool(field), str(o)[:100])
check("in the role they were invited as", (o or {}).get("role") == "field", str(o))

st, _ = call("POST", f"/team/invites/{code}/accept", {"password": "anotherpassword"})
check("the same code cannot be used twice", st == 404, f"got {st}")

st, o = call("GET", "/team", None, owner)
check("the team now has two people", len(o.get("members", [])) == 2, str(len(o.get("members", []))))
check("the accepted invite is no longer pending", o.get("invites") == [], str(o.get("invites"))[:100])
check("a field seat is free", o.get("seatsUsed") == 1, str(o.get("seatsUsed")))

print("\n== what a field user may and may not do ==")
check("they can see the company's projects", call("GET", "/projects", None, field)[0] == 200)
st, _ = call("POST", "/team/invites", {"email": "nope@team.test", "role": "field"}, field)
check("they cannot invite anyone", st == 403, f"got {st}")

print("\n== revoking ==")
_, o = call("POST", "/team/invites", {"email": "revoked@team.test", "role": "planner"}, owner)
doomed = o["invite"]
st, _ = call("DELETE", f"/team/invites/{doomed['id']}", None, owner)
check("a pending invite can be revoked", st == 204, f"got {st}")
st, _ = call("GET", f"/team/invites/{doomed['token']}/validate")
check("and its code stops working immediately", st == 404, f"got {st}")
st, _ = call("POST", f"/team/invites/{doomed['token']}/accept", {"password": "correcthorse"})
check("a revoked code cannot be redeemed", st == 404, f"got {st}")
st, _ = call("DELETE", f"/team/invites/{doomed['id']}", None, owner)
check("revoking twice is a 404, not a crash", st == 404, f"got {st}")

print("\n== only an owner can mint an owner ==")
_, o = call("POST", "/team/invites", {"email": "planner@team.test", "role": "planner"}, owner)
pcode = o["invite"]["token"]
_, o = call("POST", f"/team/invites/{pcode}/accept", {"password": "plannerpass", "name": "Pat Planner"})
planner = o["token"]
st, _ = call("POST", "/team/invites", {"email": "owner2@team.test", "role": "owner"}, planner)
check("a planner cannot invite an owner", st == 403, f"got {st}")
st, _ = call("POST", "/team/invites", {"email": "field2@team.test", "role": "field"}, planner)
check("but can invite a field user", st == 201, f"got {st}")

st, o = call("GET", "/team", None, owner)
check("planners consume a seat, field users do not", o.get("seatsUsed") == 2, str(o.get("seatsUsed")))

print("\n== an owner resets a teammate, with or without email ==")
members = {m["email"]: m for m in o["members"]}
field_id = members["field.guy@team.test"]["id"]

st, o = call("POST", f"/team/members/{field_id}/reset-password", None, planner)
check("a planner cannot reset passwords", st == 403, f"got {st}")

st, o = call("POST", f"/team/members/{field_id}/reset-password", None, owner)
check("an owner can", st == 200, f"got {st} {str(o)[:100]}")
temp = (o or {}).get("temporaryPassword")
check("and is handed a temporary password to pass on", bool(temp), str(o)[:120])
check("the message says they were signed out",
      "signed out" in (o.get("message") or "").lower(), o.get("message", ""))

check("the teammate's old session is dead", call("GET", "/projects", None, field)[0] == 401)
st, _ = call("POST", "/auth/login",
             {"slug": slug, "email": "field.guy@team.test", "password": "fieldpassword"})
check("their old password no longer works", st == 401, f"got {st}")
st, o = call("POST", "/auth/login",
             {"slug": slug, "email": "field.guy@team.test", "password": temp})
check("the temporary password does", st == 200, f"got {st}")
field = (o or {}).get("token")

st, _ = call("POST", "/team/members/00000000-0000-0000-0000-000000000000/reset-password", None, owner)
check("resetting a stranger is a 404", st == 404, f"got {st}")

print("\n== roles and standing ==")
st, o = call("PATCH", f"/team/members/{field_id}", {"role": "planner"}, owner)
check("an owner can promote someone", st == 200, f"got {st} {str(o)[:100]}")
check("the promotion signed their sessions out", call("GET", "/projects", None, field)[0] == 401)

owner_id = members["owner@team.test"]["id"]
st, o = call("PATCH", f"/team/members/{owner_id}", {"role": "field"}, owner)
check("an owner cannot demote themselves", st == 400, f"got {st}")
check("and is told why", "yourself" in (o.get("error") or "").lower(), o.get("error", ""))

st, o = call("PATCH", f"/team/members/{owner_id}", {"isActive": False}, owner)
check("nor disable themselves", st == 400, f"got {st}")

st, _ = call("PATCH", f"/team/members/{field_id}", {"isActive": False}, owner)
check("but can disable someone else", st == 200, f"got {st}")
st, _ = call("POST", "/auth/login",
             {"slug": slug, "email": "field.guy@team.test", "password": temp})
check("a disabled account cannot sign in", st == 401, f"got {st}")

print("\n== the company can never be left without an owner ==")
# A second owner, so there is one to demote.
_, o = call("POST", "/team/invites", {"email": "owner2@team.test", "role": "owner"}, owner)
_, o = call("POST", f"/team/invites/{o['invite']['token']}/accept",
            {"password": "owner2pass", "name": "Oscar Owner"})
owner2 = o["token"]
_, o = call("GET", "/team", None, owner)
owner2_id = {m["email"]: m for m in o["members"]}["owner2@team.test"]["id"]

st, _ = call("PATCH", f"/team/members/{owner2_id}", {"role": "planner"}, owner)
check("a spare owner can be demoted", st == 200, f"got {st}")

# Being demoted has to end the demoted person's sessions. Otherwise they keep
# owner access on every device they are already signed in on until the token
# happens to expire, which on a 30-day token is most of a month.
st, o = call("PATCH", f"/team/members/{owner_id}", {"role": "planner"}, owner2)
check("demotion killed their existing session", st == 401, f"got {st}")

_, o = call("POST", "/auth/login",
            {"slug": slug, "email": "owner2@team.test", "password": "owner2pass"})
owner2 = o["token"]
st, o = call("PATCH", f"/team/members/{owner_id}", {"role": "planner"}, owner2)
check("and signing back in, they are a planner who cannot change roles", st == 403, f"got {st}")

# Olivia is now the only owner. Nothing may take that away.
st, o = call("PATCH", f"/team/members/{owner_id}", {"role": "planner"}, owner)
check("the last owner cannot demote themselves", st == 400, f"got {st}")

print("\n== forgot-password tells the truth about email ==")
st, o = call("GET", "/auth/status")
check("the app can ask whether email works", st == 200, f"got {st}")
check("and the answer matches the team view", o.get("enabled") == EMAIL_ON, str(o))

st, o = call("POST", "/auth/forgot-password", {"slug": slug, "email": "owner@team.test"})
if EMAIL_ON:
    check("with email on, a reset is accepted", st == 200, f"got {st}")
    check("and the reply gives nothing away",
          "if that account exists" in (o.get("message") or "").lower(), str(o))
    st, o = call("POST", "/auth/forgot-password", {"slug": slug, "email": "nobody@nowhere.test"})
    check("an unknown address gets the identical reply", st == 200, f"got {st}")
else:
    check("with no email configured, it says so plainly", st == 503, f"got {st}")
    check("with a code the UI can branch on", (o or {}).get("code") == "EMAIL_DISABLED", str(o))
    check("and tells the user what to do instead",
          "owner" in (o.get("error") or "").lower(), o.get("error", ""))

st, o = call("GET", "/auth/reset-password/validate?token=notarealtoken")
check("a bogus reset token does not validate", st == 200 and o.get("valid") is False, str(o))

st, o = call("POST", "/auth/reset-password", {"token": "notarealtoken", "newPassword": "whatever123"})
check("and cannot be redeemed", st == 400, f"got {st}")

print("\n== companies stay separate ==")
other = f"other{random.randint(10000, 99999)}"
_, o = call("POST", "/auth/signup", {
    "companyName": "Other Co", "slug": other,
    "email": "owner@other.test", "password": PW, "name": "Odette"})
outsider = o["token"]

st, o = call("GET", "/team", None, outsider)
check("another company sees only itself", len(o.get("members", [])) == 1, str(len(o.get("members", []))))
st, _ = call("POST", f"/team/members/{field_id}/reset-password", None, outsider)
check("and cannot reset our people", st == 404, f"got {st}")
st, _ = call("PATCH", f"/team/members/{field_id}", {"role": "owner"}, outsider)
check("nor change their roles", st == 404, f"got {st}")

print("\n" + ("ALL TEAM CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
