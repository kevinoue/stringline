"""
First-run setup — and the ways an install page gets an instance stolen.

The happy path is three lines. Everything interesting is the refusals: a setup
page that anyone can post to hands the instance to whoever finds the URL first,
which is the vulnerability this design exists to avoid.

Run against a server whose database has NO companies yet:

    STRINGLINE_API=http://localhost:3099/stringline/api python3 scripts/setup.py

The token is derived from JWT_SECRET, so the suite needs the same secret the
server was started with:

    STRINGLINE_JWT_SECRET=... python3 scripts/setup.py
"""
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get("STRINGLINE_API", "http://localhost:3006/stringline/api")
SECRET = os.environ.get("STRINGLINE_JWT_SECRET")
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


def expected_token():
    """Mirror of the server's derivation. base64url, no padding, first 16."""
    digest = hashlib.sha256(f"stringline-setup:{SECRET}".encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")[:16]


if not SECRET:
    print("STRINGLINE_JWT_SECRET is required — it is what the setup code derives from.")
    sys.exit(2)

TOKEN = expected_token()
print(f"derived setup code: {TOKEN}")

print("\n== a fresh instance asks to be set up ==")
st, o = call("GET", "/setup/status")
check("status is readable without a token", st == 200, f"got {st}")
check("and says setup is needed", (o or {}).get("needed") is True, str(o))
if (o or {}).get("needed") is not True:
    print("\nThis database already has a company. Point this suite at a fresh one.")
    sys.exit(2)

print("\n== it refuses what it should ==")
GOOD = {"companyName": "Setup Co", "slug": "setupco",
        "email": "owner@setup.test", "password": "correcthorse", "name": "Owner"}

st, o = call("POST", "/setup", GOOD)
check("no setup code is rejected", st == 401, f"got {st}")
check("and the reason says where to find it", "log" in (o.get("error") or "").lower(), o.get("error", ""))

st, o = call("POST", "/setup", {**GOOD, "setupToken": "wrongwrongwrong1"})
check("a wrong setup code is rejected", st == 401, f"got {st}")
check("with a code the client can branch on", (o or {}).get("code") == "BAD_SETUP_TOKEN", str(o))

# A truncated code must not pass. If the server compared only as far as the
# shorter string, a one-character code would unlock the instance.
st, _ = call("POST", "/setup", {**GOOD, "setupToken": TOKEN[:4]})
check("a truncated setup code is rejected", st == 401, f"got {st}")

st, _ = call("POST", "/setup", {**GOOD, "setupToken": TOKEN + "x"})
check("an over-long setup code is rejected", st == 401, f"got {st}")

st, o = call("POST", "/setup", {**GOOD, "setupToken": TOKEN, "password": "short"})
check("a short password is rejected", st == 400, f"got {st}")

st, o = call("POST", "/setup", {**GOOD, "setupToken": TOKEN, "slug": "NO_UNDERSCORES"})
check("an invalid company code is rejected", st == 400, f"got {st}")

st, o = call("POST", "/setup", {"setupToken": TOKEN, "companyName": "X"})
check("missing fields are rejected", st == 400, f"got {st}")

st, o = call("GET", "/setup/status")
check("none of that claimed the instance", (o or {}).get("needed") is True, str(o))

print("\n== setting it up ==")
st, o = call("POST", "/setup", {**GOOD, "setupToken": TOKEN})
check("the right setup code works", st == 201, f"got {st} {o}")
check("and returns a usable session", "token" in (o or {}), str(o)[:120])
owner = (o or {}).get("token")
check("the company code comes back normalised", (o or {}).get("slug") == "setupco", str(o))

check("the new owner can use the API immediately",
      call("GET", "/projects", None, owner)[0] == 200)

print("\n== and it cannot be done twice ==")
st, o = call("GET", "/setup/status")
check("status now says setup is done", (o or {}).get("needed") is False, str(o))

st, o = call("POST", "/setup", {**GOOD, "setupToken": TOKEN, "slug": "secondco"})
check("a second setup is refused", st == 409, f"got {st}")
check("with ALREADY_SET_UP", (o or {}).get("code") == "ALREADY_SET_UP", str(o))

# The ordering matters: an already-set-up instance must refuse before it looks
# at the code, so the endpoint cannot be used as an oracle to test codes
# against a live instance.
st, o = call("POST", "/setup", {**GOOD, "setupToken": "definitelywrong", "slug": "thirdco"})
check("and refuses a wrong code the same way, not as a 401",
      st == 409, f"got {st} — a 401 here would confirm codes to a stranger")

print("\n== the owner is a normal owner ==")
st, o = call("POST", "/auth/login",
             {"slug": "setupco", "email": "owner@setup.test", "password": "correcthorse"})
check("they can sign in normally", st == 201 or st == 200, f"got {st}")
check("and they are the owner", ((o or {}).get("user") or {}).get("role") == "owner", str(o)[:140])

print("\n== signup still works after the refactor ==")
# /auth/signup and /setup share one provisioning service now. If extracting it
# broke the default calendar, a project could not be created at all — so this
# goes as far as making one.
st, o = call("POST", "/auth/signup", {
    "companyName": "Signup Co", "slug": "signupco2",
    "email": "s@signup.test", "password": "correcthorse", "name": "S"})
check("signup still creates a company", st == 201, f"got {st} {o}")
other = (o or {}).get("token")
st, o = call("POST", "/projects", {"name": "Proves the calendar exists",
                                   "startDate": "2026-11-02"}, other)
check("and that company has a working calendar", st == 201, f"got {st} {str(o)[:120]}")

print("\n" + ("ALL SETUP CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
