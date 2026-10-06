"""
Changing your own password — and the ways that could go wrong.

The interesting part is not the happy path. It is that a password change must
invalidate other sessions, must require the *old* password even though the
request is already authenticated, and must not lock the person out of the
session they are using to make the change.
"""
import json
import os
import random
import sys
import time
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


slug = f"pw{random.randint(10000, 99999)}"
OLD, NEW = "correcthorse", "batterystaple9"
_, o = call("POST", "/auth/signup", {
    "companyName": "PW Co", "slug": slug,
    "email": "p@pw.test", "password": OLD, "name": "P"})
first = o["token"]

# A second session, to prove the change signs it out.
_, o = call("POST", "/auth/login", {"slug": slug, "email": "p@pw.test", "password": OLD})
other = o["token"]
check("two sessions are live", call("GET", "/projects", None, other)[0] == 200)

print("\n== it refuses what it should ==")
st, o = call("POST", "/auth/change-password", {"currentPassword": OLD, "newPassword": NEW})
check("an unauthenticated request is rejected", st == 401, f"got {st}")

st, o = call("POST", "/auth/change-password",
             {"currentPassword": "wrong", "newPassword": NEW}, first)
check("the wrong current password is rejected", st == 401, f"got {st}")
check("and says so plainly", "incorrect" in (o.get("error") or "").lower(), o.get("error", ""))

st, o = call("POST", "/auth/change-password", {"currentPassword": OLD, "newPassword": "short"}, first)
check("a short new password is rejected", st == 400, f"got {st}")

st, o = call("POST", "/auth/change-password", {"currentPassword": OLD, "newPassword": OLD}, first)
check("reusing the same password is rejected", st == 400, f"got {st}")

st, o = call("POST", "/auth/change-password", {"currentPassword": OLD}, first)
check("a missing field is rejected", st == 400, f"got {st}")

check("none of that changed anything",
      call("POST", "/auth/login", {"slug": slug, "email": "p@pw.test", "password": OLD})[0] == 200)

print("\n== changing it ==")
st, o = call("POST", "/auth/change-password", {"currentPassword": OLD, "newPassword": NEW}, first)
check("the change succeeds", st == 200, f"got {st} {o}")
check("and returns a replacement token", "token" in (o or {}))
fresh = o["token"]

check("the old password no longer works",
      call("POST", "/auth/login", {"slug": slug, "email": "p@pw.test", "password": OLD})[0] == 401)
check("the new password does",
      call("POST", "/auth/login", {"slug": slug, "email": "p@pw.test", "password": NEW})[0] == 200)

print("\n== sessions ==")
# The token that made the change must keep working, or the user is thrown out
# of the screen they are standing in.
check("the session that made the change still works",
      call("GET", "/projects", None, fresh)[0] == 200)

st, o = call("GET", "/projects", None, other)
check("the other session is signed out", st == 401, f"got {st}")
check("and is told why", (o or {}).get("code") == "PASSWORD_CHANGED", str(o))

st, _ = call("GET", "/projects", None, first)
check("so is the pre-change token", st == 401, f"got {st}")

print("\n== and it can be changed again ==")
time.sleep(1)
st, o = call("POST", "/auth/change-password",
             {"currentPassword": NEW, "newPassword": "thirdpassword7"}, fresh)
check("a second change works", st == 200, f"got {st} {o}")
check("the newest session survives it", call("GET", "/projects", None, o["token"])[0] == 200)

print("\n" + ("ALL PASSWORD CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
