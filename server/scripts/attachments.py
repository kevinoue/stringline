"""
Task attachments — and, mostly, the ways someone could abuse them.

File upload is the easiest way to put a hole in a web app, so the bulk of this
suite is adversarial: wrong types, disguised types, path traversal, cross-company
access, and the SVG-as-image trick that turns an upload feature into stored XSS.
"""
import io
import json
import os
import random
import sys
import time
import urllib.request
import uuid

API = os.environ.get("STRINGLINE_API", "http://localhost:3006/stringline/api")
TOKEN = None
failures = []


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": f"Bearer {token or TOKEN}"} if (token or TOKEN) else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, (json.load(r) if r.status != 204 else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"null")
        except Exception:
            return e.code, {"raw": raw[:200].decode("latin1")}


def multipart(path, filename, content, token=None, field="file"):
    boundary = f"----stringline{uuid.uuid4().hex}"
    body = b"".join([
        f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f'Content-Type: application/octet-stream\r\n\r\n'.encode(),
        content, f"\r\n--{boundary}--\r\n".encode(),
    ])
    req = urllib.request.Request(
        API + path, method="POST", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                 "Authorization": f"Bearer {token or TOKEN}"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"null")
        except Exception:
            return e.code, {"raw": raw[:200].decode("latin1")}


def download(path, token=None):
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {token or TOKEN}"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def check(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        failures.append(label)


PDF = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"
PNG = (bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
       + b"\x00\x00\x00\rIHDR" + b"\x00" * 40)
DOCX = bytes([0x50, 0x4B, 0x03, 0x04]) + b"fake docx payload" * 8

slug = f"att-{random.randint(10000, 99999)}"
_, o = call("POST", "/auth/signup", {
    "companyName": "Attach Co", "slug": slug,
    "email": "a@att.test", "password": "correcthorse", "name": "A"})
TOKEN = o["token"]
_, o = call("POST", "/projects", {"name": "Proof", "startDate": "2026-01-05"})
pid = o["project"]["id"]
_, o = call("POST", f"/projects/{pid}/tasks", {"name": "Final inspection", "durationDays": 2})
tid = o["taskId"]

print("\n== uploading ==")
st, o = multipart(f"/tasks/{tid}/attachments", "certificate.pdf", PDF)
check("a PDF uploads", st == 201, f"got {st} {o}")
pdf_id = o["attachment"]["id"] if st == 201 else None
check("original name kept for display", o.get("attachment", {}).get("originalName") == "certificate.pdf")
check("type identified from the bytes", o.get("attachment", {}).get("mimeType") == "application/pdf")

st, o = multipart(f"/tasks/{tid}/attachments", "site-photo.png", PNG)
check("a PNG uploads", st == 201, f"got {st}")
png_id = o["attachment"]["id"] if st == 201 else None
st, o = multipart(f"/tasks/{tid}/attachments", "sign-off.docx", DOCX)
check("a Word document uploads", st == 201, f"got {st}")

st, o = call("GET", f"/tasks/{tid}/attachments")
check("all three are listed", len(o["attachments"]) == 3, str(len(o["attachments"])))
check("the accepted list is advertised", "pdf" in o["accepted"] and "svg" not in o["accepted"],
      str(o["accepted"]))

print("\n== the declared type is not evidence ==")
st, o = multipart(f"/tasks/{tid}/attachments", "invoice.pdf", b"MZ\x90\x00 this is a windows exe")
check("an executable renamed .pdf is rejected", st == 422, f"got {st}")
check("and says why", "does not look like" in (o.get("error") or ""), o.get("error", ""))

st, o = multipart(f"/tasks/{tid}/attachments", "photo.png", PDF)
check("a PDF renamed .png is rejected", st == 422, f"got {st}")

print("\n== SVG is a script container, not an image ==")
svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>'
st, o = multipart(f"/tasks/{tid}/attachments", "logo.svg", svg)
check("SVG is refused outright", st == 422, f"got {st}")
st, o = multipart(f"/tasks/{tid}/attachments", "page.html", b"<html><script>alert(1)</script>")
check("HTML is refused outright", st == 422, f"got {st}")

print("\n== the client never names a file on disk ==")
st, o = multipart(f"/tasks/{tid}/attachments", "../../../../etc/passwd.pdf", PDF)
# Traversal in the *name* is fine as long as it never reaches a path.
check("a traversal filename is accepted but neutralised", st == 201, f"got {st}")
if st == 201:
    trav_id = o["attachment"]["id"]
    st2, headers, body = download(f"/attachments/{trav_id}")
    check("it downloads as a plain filename", st2 == 200 and ".." not in headers.get("Content-Disposition", ""),
          headers.get("Content-Disposition", ""))

print("\n== downloads are served defensively ==")
st, headers, body = download(f"/attachments/{pdf_id}")
check("the PDF comes back byte-for-byte", st == 200 and body == PDF, f"{st}, {len(body)} bytes")
check("PDFs download rather than render", headers.get("Content-Disposition", "").startswith("attachment"),
      headers.get("Content-Disposition", ""))
check("nosniff is set", headers.get("X-Content-Type-Options") == "nosniff")
check("a script-free CSP is set", "default-src 'none'" in (headers.get("Content-Security-Policy") or ""),
      headers.get("Content-Security-Policy", ""))

st, headers, body = download(f"/attachments/{png_id}")
check("images may render in place", headers.get("Content-Disposition", "").startswith("inline"),
      headers.get("Content-Disposition", ""))
check("but still sandboxed", "sandbox" in (headers.get("Content-Security-Policy") or ""))

print("\n== another company cannot reach any of it ==")
_, other = call("POST", "/auth/signup", {
    "companyName": "Other", "slug": f"oth-{random.randint(10000,99999)}",
    "email": "o@o.test", "password": "correcthorse", "name": "O"})
ot = other["token"]
st, _, _ = download(f"/attachments/{pdf_id}", token=ot)
check("cross-company download is 404", st == 404, f"got {st}")
st, _ = call("GET", f"/tasks/{tid}/attachments", token=ot)
check("cross-company listing is 404", st == 404, f"got {st}")
st, _ = call("DELETE", f"/attachments/{pdf_id}", token=ot)
check("cross-company delete is 404", st == 404, f"got {st}")
st, _ = multipart(f"/tasks/{tid}/attachments", "sneak.pdf", PDF, token=ot)
check("cross-company upload is 404", st == 404, f"got {st}")

print("\n== limits and cleanup ==")
st, o = multipart(f"/tasks/{tid}/attachments", "huge.pdf", PDF + b"\x00" * (26 * 1024 * 1024))
check("oversized uploads are rejected", st in (413, 422, 500), f"got {st}")
st, o = multipart(f"/tasks/{tid}/attachments", "nothing.pdf", b"")
check("empty uploads are rejected", st == 422, f"got {st}")
st, o = multipart(f"/tasks/{tid}/attachments", "noextension", PDF)
check("a file with no extension is rejected", st == 422, f"got {st}")

st, _ = call("DELETE", f"/attachments/{pdf_id}")
check("owner can delete", st == 204, f"got {st}")
st, _, _ = download(f"/attachments/{pdf_id}")
check("and it is gone", st == 404, f"got {st}")

print("\n== deleting the task takes its files with it ==")
# The row going is only half of it. `attachments` cascades from `tasks`, so the
# rows vanish on their own — but nothing used to unlink the files, and a live
# instance accumulated thirteen files against four rows. On a real job those are
# completion photographs, so the directory only ever grows, and a restore brings
# back files the app cannot see.
upload_dir = os.environ.get("STRINGLINE_UPLOAD_DIR")
before = set(os.listdir(upload_dir)) if upload_dir and os.path.isdir(upload_dir) else None

call("DELETE", f"/projects/{pid}/tasks/{tid}")
st, _, _ = download(f"/attachments/{png_id}")
check("attachments cascade with the task", st == 404, f"got {st}")

if before is None:
    print("  SKIP  set STRINGLINE_UPLOAD_DIR to also check the files left the disk")
else:
    time.sleep(0.5)  # the unlink happens after the response is sent
    after = set(os.listdir(upload_dir))
    leaked = before - after
    check("and the files leave the disk too", len(after) < len(before),
          f"{len(before)} -> {len(after)} files")
    check("exactly the deleted task's files went", len(leaked) == 3,
          f"removed {len(leaked)}")

print("\n" + ("ALL ATTACHMENT CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
