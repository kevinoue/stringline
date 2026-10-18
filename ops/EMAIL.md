# Sending email from Stringline

Stringline sends three kinds of mail, all transactional and all low volume:

| When | What it says |
|---|---|
| Someone is invited | The invite link and code |
| An owner resets a teammate's password | The temporary password |
| Somebody asks to reset their own password | A link, good for 15 minutes |
| A password changes, or a role changes | A security notice to the person it happened to |

**None of it is required.** With nothing configured, invite codes and temporary
passwords come back in the app for an owner to pass on by text or in person,
and only self-service "forgot password" is unavailable — it says so plainly
rather than pretending to send something.

---

## Using a Gmail account

The simplest option, and the one to pick unless you have a reason not to.

### 1. Turn on 2-Step Verification

Google will not issue an app password without it.
<https://myaccount.google.com/signinoptions/two-step-verification>

### 2. Create an app password

<https://myaccount.google.com/apppasswords> → name it `Stringline` → copy the
16 characters it shows you. Google displays it **once**.

This is not your Google password. It is scoped to mail, it can be revoked on
its own without touching anything else, and it cannot be used to sign in to
your account. That distinction is the whole reason this approach is acceptable:
a leaked app password is a bad afternoon, a leaked account password is not.

### 3. Put it in `ops.env`

```sh
SMTP_PRESET=gmail
SMTP_USER=you@gmail.com
SMTP_PASS=abcdefghijklmnop          # the 16 characters, spaces removed
PUBLIC_URL=https://kevinoue.com/stringline
```

`SMTP_HOST`, `SMTP_PORT` and TLS are filled in by the preset. `SMTP_FROM`
defaults to `SMTP_USER`, which is deliberate — **Gmail rewrites a From address
it does not own**, so setting it to something else gets you a header that
silently does not match what was sent. If you want a different sending address,
verify it in Gmail first (Settings → Accounts → Send mail as) and then set
`SMTP_FROM`.

### 4. Restart and check the log

```
[email] SMTP: you@gmail.com via smtp.gmail.com:465 (TLS)
```

The credentials are proved at boot, so a wrong app password is reported then
rather than discovered when somebody cannot reset their password.

---

## Using an iCloud account

```sh
SMTP_PRESET=icloud
SMTP_USER=you@icloud.com
SMTP_PASS=abcd-efgh-ijkl-mnop        # app-specific password, keep the hyphens
```

App-specific password: <https://appleid.apple.com> → Sign-In and Security →
App-Specific Passwords. Two-factor must be on, same as Google.

iCloud only accepts a From address that belongs to the account — your
`@icloud.com`, `@me.com` or `@mac.com` address, or a verified alias. Anything
else is rejected at send time rather than silently rewritten.

iCloud's send limits are lower than Gmail's and it is fussier about mail that
looks bulk. For a handful of invites it is fine.

---

## Any other mailbox

```sh
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=stringline@example.com
SMTP_PASS=...
SMTP_FROM=stringline@example.com     # optional, defaults to SMTP_USER
```

`SMTP_SECURE` is inferred from the port and you should not normally set it:
**465 is TLS from the first byte, 587 opens in the clear and upgrades with
STARTTLS.** Getting that pair wrong produces a hang rather than an error, which
is a miserable thing to debug.

Certificate verification is on and there is no option to turn it off. On 587
the session starts unencrypted, so a stripped STARTTLS with verification
disabled hands your app password to whoever is in the middle — which is exactly
what every "my SMTP doesn't work" answer on the internet tells you to do.

---

## Resend

Still supported, unchanged, for an instance already using it:

```sh
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=stringline@yourdomain.com
```

SMTP takes precedence if both are set.

---

## What to expect from a personal mailbox

Three things are true of this that are not true of a transactional provider,
and all three are fine at this size:

1. **Daily limits.** Roughly 500 recipients a day for consumer Gmail, fewer for
   iCloud. An invite and the occasional reset are nowhere near it, and if you
   ever do hit it the error is reported rather than swallowed.
2. **Deliverability.** Mail from a personal address to someone who has never
   corresponded with you may land in spam. For invites this matters less than
   it sounds, because the code is also shown in the app for you to pass on
   directly — tell people to check their spam folder the first time.
3. **It is your mailbox.** Sent mail appears in your Sent folder, and replies
   come to you rather than to nobody. For a six-person contractor this is a
   feature.

If Stringline ever grows past that, a domain with SPF and DKIM through a
transactional provider is the upgrade, and it is one environment variable.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `535 Username and Password not accepted` | `SMTP_PASS` is the account password, not an app password. Creating an app password is the fix; changing your Google password is not. |
| Boot hangs, no `[email]` line | Port and TLS mismatched — 465 with `SMTP_SECURE=false`, or 587 with `true`. Remove `SMTP_SECURE` and let the port decide. |
| `SMTP is half-configured` | A host with no password, or a user with no host. Deliberately fatal to the mail config rather than quietly falling back to "disabled", because watching for mail that was never going to be attempted is worse. |
| Mail sends but the From is wrong | Gmail rewrote it. Verify the alias in Gmail or drop `SMTP_FROM`. |
| Nothing arrives, no error | Check spam. Then check the log — every send is logged with its message id. |
