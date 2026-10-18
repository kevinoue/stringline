"""
The controls around getting in.

Four things here are not obvious from reading the routes, and all four are the
sort of defect that leaves no trace until somebody is already inside:

  * **Login must take the same time whether or not the account exists.** An
    identical error message is not enough on its own — skipping the bcrypt for
    an address with no account answers in a millisecond instead of two hundred,
    and that gap is a perfectly good enumeration oracle over the network.
  * **Lockout must apply to addresses that do not exist.** If only real
    accounts get throttled, the throttle itself tells an attacker which
    addresses are real, and the feature meant to stop enumeration becomes the
    thing that enables it.
  * **A client seat must not read the team.** A client is an outside party; the
    staff list with everyone's address is the customer's data, not theirs.
  * **The audit trail must actually record things.** It is the only artefact
    that survives an incident, and a log nobody has watched being written is a
    log that turns out to be empty on the day it matters.

Run against a server with a generous AUTH_RATE_LIMIT, or the outer per-IP
limiter answers before any of the behaviour under test is reached:

    AUTH_RATE_LIMIT=2000 INVITE_RATE_LIMIT=2000 ... node dist/index.js
    python3 scripts/security.py
"""
import json
import os
import random
import statistics
import sys
import time
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


def timed(method, path, body=None, token=None):
    start = time.perf_counter()
    status, payload = call(method, path, body, token)
    return status, payload, (time.perf_counter() - start) * 1000


def check(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        failures.append(label)


tag = random.randint(1000, 9999)
SLUG = f"sec-{tag}"
OWNER = f"owner@sec{tag}.test"
PASSWORD = "harbour-crane-slip"

print("== a company to test against ==")
st, o = call("POST", "/auth/signup", {
    "companyName": f"Security {tag}", "slug": SLUG,
    "email": OWNER, "password": PASSWORD, "name": "Olive Owner",
})
check("it signs up", st == 201, f"got {st} {o}")
owner = o["token"]

# ─── Password policy ─────────────────────────────────────────────────────────

print("\n== what counts as an acceptable password ==")
# The slug is generated per case, and the "company code" case builds its
# password *from that slug* — an earlier version of this test used a different
# slug in the password than in the signup, so the rule it claimed to check was
# never exercised and the check passed for the wrong reason.
def reject_case(label, make_password):
    slug = f"nope-{random.randint(10000, 99999)}"
    st, o = call("POST", "/auth/signup", {
        "companyName": "Nope", "slug": slug,
        "email": f"owner@sec{tag}.test", "password": make_password(slug), "name": "No One",
    })
    check(f"rejected: {label}", st == 400, f"got {st} — {(o or {}).get('error', '')[:60]}")


reject_case("too short", lambda slug: "short1")
reject_case("one of the first anyone tries", lambda slug: "password123")
reject_case("the company code", lambda slug: f"{slug}-{slug}")
reject_case("the email address", lambda slug: f"owner@sec{tag}xx")
reject_case("one repeated character", lambda slug: "aaaaaaaaaaaa")

st, o = call("POST", "/auth/signup", {
    "companyName": "Fine", "slug": f"fine-{tag}",
    "email": "someone@elsewhere.test", "password": "correct horse battery staple",
    "name": "Fine Person",
})
# A long memorable phrase is exactly what the policy is meant to encourage, so
# it had better not be caught by any of the rules above.
check("accepted: a long passphrase", st == 201, f"got {st} {(o or {}).get('error', '')}")

st, o = call("POST", "/auth/signup", {
    "companyName": "Long", "slug": f"long-{tag}",
    "email": "long@elsewhere.test", "password": "x" * 100, "name": "Too Long",
})
# bcrypt silently truncates at 72 bytes. Accepting a 100-character password and
# only honouring the first 72 is worse than saying so.
check("rejected: past what bcrypt will hash", st == 400, f"got {st}")

# ─── Enumeration ─────────────────────────────────────────────────────────────

print("\n== login tells you nothing about who exists ==")

# Fresh, unused addresses each time, so the throttle below does not fire during
# the timing measurement and skew it.
def wrong_password_ms():
    _, _, ms = timed("POST", "/auth/login",
                     {"slug": SLUG, "email": OWNER, "password": "definitely-not-it"})
    return ms


def no_such_account_ms():
    _, _, ms = timed("POST", "/auth/login", {
        "slug": SLUG, "email": f"ghost{random.randint(1, 10 ** 9)}@sec{tag}.test",
        "password": "definitely-not-it"})
    return ms


def no_such_company_ms():
    _, _, ms = timed("POST", "/auth/login", {
        "slug": f"ghost-{random.randint(1, 10 ** 9)}", "email": OWNER,
        "password": "definitely-not-it"})
    return ms


def clear_failures():
    """Sign in properly, which wipes the account's recent failures."""
    call("POST", "/auth/login", {"slug": SLUG, "email": OWNER, "password": PASSWORD})


# Three samples each, interleaved so a slow moment on the machine lands on all
# three rather than on whichever ran first.
#
# Every wrong-password sample is followed by a real sign-in, because the
# lockout is five failures in fifteen minutes and this account is the only one
# available to get a wrong password *against*. Without the reset, the fourth
# sample measures the 429 path — which returns in about a millisecond and makes
# the timing comparison pass for entirely the wrong reason, while locking the
# account out for everything after it.
wrong, missing, nocompany = [], [], []
for _ in range(3):
    missing.append(no_such_account_ms())
    nocompany.append(no_such_company_ms())
for _ in range(3):
    wrong.append(wrong_password_ms())
    clear_failures()

w, m, n = statistics.median(wrong), statistics.median(missing), statistics.median(nocompany)
print(f"       wrong password {w:.0f}ms · no such account {m:.0f}ms · no such company {n:.0f}ms")

# Without the decoy hash the missing-account path returns in single-digit
# milliseconds against ~200ms of bcrypt. Half is a generous floor that still
# fails loudly if the decoy is ever removed.
check("an unknown address takes as long as a wrong password", m >= w * 0.5,
      f"{m:.0f}ms vs {w:.0f}ms")
check("and so does an unknown company code", n >= w * 0.5, f"{n:.0f}ms vs {w:.0f}ms")

st, o = call("POST", "/auth/login", {"slug": SLUG, "email": OWNER, "password": "nope-nope-nope"})
st2, o2 = call("POST", "/auth/login",
               {"slug": SLUG, "email": f"ghost@sec{tag}.test", "password": "nope-nope-nope"})
check("the two answers are byte-identical", (st, o) == (st2, o2), f"{o} vs {o2}")
clear_failures()

# Signing in successfully clears the failures just accumulated, so the lockout
# section below starts from a clean slate.
st, o = call("POST", "/auth/login", {"slug": SLUG, "email": OWNER, "password": PASSWORD})
check("the real password still works", st == 200, f"got {st}")
owner = o["token"]

# ─── Lockout ─────────────────────────────────────────────────────────────────

print("\n== repeated guessing stops being answered ==")
VICTIM = f"locked@sec{tag}.test"
for i in range(5):
    st, _ = call("POST", "/auth/login", {"slug": SLUG, "email": VICTIM, "password": f"guess{i}"})
status, payload = call("POST", "/auth/login",
                       {"slug": SLUG, "email": VICTIM, "password": "guess-again"})
check("an address with no account locks out like a real one", status == 429,
      f"got {status}")
check("with something the client can act on", (payload or {}).get("code") == "LOCKED_OUT",
      str((payload or {}).get("code")))
check("and a Retry-After to wait for", isinstance((payload or {}).get("retryAfter"), int),
      str((payload or {}).get("retryAfter")))

# The real account, locked the same way — and crucially the lock must not be a
# way to deny service to someone who knows their password... it is, for fifteen
# minutes, which is the accepted trade. What matters here is that the behaviour
# is identical to the nonexistent address above.
for i in range(5):
    call("POST", "/auth/login", {"slug": SLUG, "email": OWNER, "password": f"guess{i}"})
status2, payload2 = call("POST", "/auth/login",
                         {"slug": SLUG, "email": OWNER, "password": PASSWORD})
check("a real account locks identically", status2 == 429, f"got {status2}")
check("so the lock reveals nothing either", (payload2 or {}).get("code") == "LOCKED_OUT")

# ─── What a client seat can see ──────────────────────────────────────────────

print("\n== a client seat is an outsider ==")
st, o = call("POST", "/team/invites", {"email": f"client@sec{tag}.test", "role": "client"}, owner)
check("a client can be invited", st == 201, f"got {st}")
code = o["invite"]["token"]
st, o = call("POST", f"/team/invites/{code}/accept",
             {"password": "lantern-ridge-walk", "name": "Clara Client"})
check("and can accept", st == 201, f"got {st}")
client = o["token"]

st, o = call("GET", "/team", None, client)
check("but cannot read the team", st == 403, f"got {st}")

st, o = call("POST", "/team/invites", {"email": "x@y.test", "role": "field"}, client)
check("nor invite anybody", st == 403, f"got {st}")

st, o = call("GET", "/team/security-log", None, client)
check("nor read the security log", st == 403, f"got {st}")

print("\n== a field seat sees people, not addresses ==")
st, o = call("POST", "/team/invites", {"email": f"field@sec{tag}.test", "role": "field"}, owner)
code = o["invite"]["token"]
st, o = call("POST", f"/team/invites/{code}/accept",
             {"password": "mortar-board-cut", "name": "Fred Field"})
field = o["token"]

st, o = call("GET", "/team", None, field)
check("they can read the team", st == 200, f"got {st}")
check("but no email addresses come back",
      all("email" not in m for m in o["members"]),
      f"{len(o['members'])} members")
check("and no pending invite codes", o["invites"] == [], str(o["invites"])[:60])

st, o = call("GET", "/team/security-log", None, field)
check("and the security log is not theirs", st == 403, f"got {st}")

# ─── The audit trail ─────────────────────────────────────────────────────────

print("\n== the log records what happened ==")
st, log = call("GET", "/team/security-log", None, owner)
check("an owner can read it", st == 200, f"got {st}")
kinds = [e["kind"] for e in log["events"]]

for kind in ["login.succeeded", "login.failed", "login.blocked",
             "invite.created", "invite.accepted"]:
    check(f"it recorded {kind}", kind in kinds, f"{kinds.count(kind)}×")

check("failed attempts in the last day are counted", log["failedLast24h"] >= 5,
      str(log["failedLast24h"]))
check("as are the blocked ones", log["blockedLast24h"] >= 1, str(log["blockedLast24h"]))

blocked = next(e for e in log["events"] if e["kind"] == "login.blocked")
check("an event says who it was about", blocked["subject"] is not None, str(blocked["subject"]))
check("and records where it came from", "ip" in blocked, str(blocked.get("ip")))

# A role change must be in there, with both people named.
st, members = call("GET", "/team", None, owner)
field_id = {m["email"]: m for m in members["members"]}[f"field@sec{tag}.test"]["id"]
st, _ = call("PATCH", f"/team/members/{field_id}", {"role": "planner"}, owner)
check("a role change goes through", st == 200, f"got {st}")

st, log = call("GET", "/team/security-log", None, owner)
change = next((e for e in log["events"] if e["kind"] == "member.role_changed"), None)
check("and is recorded", change is not None)
if change:
    check("naming who did it", change["actor_name"] == "Olive Owner", str(change["actor_name"]))
    check("and who it was done to", change["subject"] == f"field@sec{tag}.test", str(change["subject"]))

# ─── Sessions ────────────────────────────────────────────────────────────────

print("\n== ending every session ==")
st, o = call("POST", "/auth/login", {"slug": SLUG, "email": f"client@sec{tag}.test",
                                     "password": "lantern-ridge-walk"})
check("the client can sign in", st == 200, f"got {st}")
first = o["token"]
check("and is told when they last signed in", "lastLogin" in o, str(o.get("lastLogin")))

st, o = call("POST", "/auth/login", {"slug": SLUG, "email": f"client@sec{tag}.test",
                                     "password": "lantern-ridge-walk"})
second = o["token"]
check("the second sign-in reports the first", o.get("lastLogin") is not None, str(o.get("lastLogin")))

st, _ = call("GET", "/auth/me", None, first)
check("both sessions work to begin with", st == 200, f"got {st}")

st, _ = call("POST", "/auth/sign-out-everywhere", None, second)
check("signing out everywhere succeeds", st == 200, f"got {st}")

st, o = call("GET", "/auth/me", None, first)
check("the other session is dead", st == 401, f"got {st}")
st, o = call("GET", "/auth/me", None, second)
check("and so is the one that asked", st == 401, f"got {st}")

# ─── /me is not a credential endpoint ────────────────────────────────────────

print("\n== ordinary requests do not spend the login budget ==")
# /auth/me lives under the same prefix as /auth/login and used to share its
# tight limit — twenty page loads in a quarter of an hour and you could no
# longer sign in.
# That account belongs to the `fine-` company created in the policy section,
# not to SLUG. Signing in with the wrong company code would leave `other` unset
# and the loop below would quietly not run — a check that skips itself is worse
# than one that fails.
st, o = call("POST", "/auth/login", {"slug": f"fine-{tag}", "email": "someone@elsewhere.test",
                                     "password": "correct horse battery staple"})
check("a second company's owner can sign in", st == 200, f"got {st} {o}")
other = o["token"]

codes = set()
for _ in range(25):
    st, _ = call("GET", "/auth/me", None, other)
    codes.add(st)
check("25 calls to /auth/me all succeed", codes == {200}, str(codes))

print()
if failures:
    print(f"{len(failures)} FAILURES:")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("ALL SECURITY CHECKS PASSED")
