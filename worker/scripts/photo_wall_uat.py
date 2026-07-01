"""End-to-end UAT for the saturfun photo wall against a LIVE Worker URL.

Ported from Artifact Studio's photo_wall_uat.py and adapted to saturfun:
  - DELETE is owner-gated -> pass --owner-token (sent as X-Owner-Token).
  - No server-side thumbnails on the edge -> has_thumb is False; the /thumb
    endpoint still returns 200 (falls back to the original).
  - Saturfun is a static site (no PWA): the Artifact-Studio app.js/sw.js/manifest
    checks are replaced by a check that wall.js ships the phone-aware save path.

Every uploaded asset is deleted again (with the owner token), so the wall is left
exactly as found. Exit code 0 == all green.

Usage:
    python photo_wall_uat.py [--base URL] [--owner-token TOKEN] [--rounds N] [--wall-js PATH]
Local default targets `wrangler dev` (http://127.0.0.1:8787) with the test token.
"""
from __future__ import annotations

import argparse
import base64
import io
import sys
import time
from pathlib import Path

import httpx

# --- real, decodable test assets ------------------------------------------
PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
GIF_1x1 = base64.b64decode("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==")
# Synthetic but validly-sniffed HEIC header (iPhone camera default container).
# The edge can't thumbnail it — the wall must still store + serve it.
HEIC_HEADER = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" + b"\x00" * 64

IPHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")
ANDROID_UA = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36")


def _real_jpeg() -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, format="JPEG")
    return buf.getvalue()


def _real_webp() -> bytes | None:
    from PIL import Image
    buf = io.BytesIO()
    try:
        Image.new("RGB", (8, 8), (30, 30, 200)).save(buf, format="WEBP")
    except Exception:
        return None
    return buf.getvalue()


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.fails: list[str] = []

    def check(self, name: str, cond: bool, detail: str = "") -> None:
        if cond:
            self.passed += 1
        else:
            self.failed += 1
            self.fails.append(f"{name}: {detail}")
            print(f"   FAIL  {name}  {detail}")


def upload(client: httpx.Client, base: str, data: bytes, name: str, ctype: str):
    return client.post(f"{base}/api/photos",
                       files={"files": (name, data, ctype)}, timeout=30)


def delete(client: httpx.Client, base: str, pid: str, token: str):
    return client.delete(f"{base}/api/photos/{pid}",
                         headers={"X-Owner-Token": token}, timeout=15)


def round_once(client: httpx.Client, base: str, token: str, r: Results, rnd: int) -> None:
    created_ids: list[str] = []

    # 1) PNG round-trip (dimensions parsed from header on the edge)
    resp = upload(client, base, PNG_1x1, f"r{rnd}_cat.png", "image/png")
    r.check("png_upload_200", resp.status_code == 200, f"got {resp.status_code} {resp.text[:120]}")
    if resp.status_code == 200:
        p = resp.json()["photos"][0]
        created_ids.append(p["id"])

        # reactions: add two emojis, verify summary + per-device mine, remove one
        dev = f"uat-dev-{rnd}"
        rr = client.post(f"{base}/api/photos/{p['id']}/react", json={"device_id": dev, "emoji": "😂"}, timeout=15)
        ok1 = rr.status_code == 200 and rr.json().get("reactions") == [{"emoji": "😂", "count": 1, "mine": True}]
        r.check("react_add_200", ok1, rr.text[:140])
        client.post(f"{base}/api/photos/{p['id']}/react", json={"device_id": dev, "emoji": "❤️"}, timeout=15)
        listed = client.get(f"{base}/api/photos?device={dev}", timeout=15).json()["photos"]
        me = next((x for x in listed if x["id"] == p["id"]), {})
        emojis = {x["emoji"] for x in me.get("reactions", [])}
        r.check("react_reflected", emojis == {"😂", "❤️"} and all(x["mine"] for x in me["reactions"]), str(me)[:180])
        bad = client.post(f"{base}/api/photos/{p['id']}/react", json={"device_id": dev, "emoji": "haha"}, timeout=15)
        r.check("react_rejects_text", bad.status_code == 400, bad.text[:120])
        off = client.post(f"{base}/api/photos/{p['id']}/react", json={"device_id": dev, "emoji": "😂"}, timeout=15)
        r.check("react_remove", off.status_code == 200 and all(x["emoji"] != "😂" for x in off.json()["reactions"]), off.text[:140])

        # comments: set name, post, list, count, author-delete
        client.put(f"{base}/api/profile", json={"device_id": dev, "name": f"uat-{rnd}"}, timeout=15)
        cr = client.post(f"{base}/api/photos/{p['id']}/comments", json={"device_id": dev, "body": "uat comment"}, timeout=15)
        cid = cr.json().get("id")
        r.check("comment_post_201", cr.status_code == 201 and cr.json().get("name") == f"uat-{rnd}", cr.text[:140])
        lst = client.get(f"{base}/api/photos/{p['id']}/comments", timeout=15).json()["comments"]
        r.check("comment_listed", any(c["id"] == cid and c["body"] == "uat comment" for c in lst), str(lst)[:160])
        cc = next((x for x in client.get(f"{base}/api/photos?device={dev}", timeout=15).json()["photos"] if x["id"] == p["id"]), {})
        r.check("comment_count", cc.get("comment_count") == 1, str(cc)[:140])
        bad = client.post(f"{base}/api/photos/{p['id']}/comments", json={"device_id": dev, "body": "   "}, timeout=15)
        r.check("comment_rejects_empty", bad.status_code == 400, bad.text[:120])
        dl = client.request("DELETE", f"{base}/api/photos/{p['id']}/comments/{cid}", json={"device_id": dev}, timeout=15)
        r.check("comment_author_delete", dl.status_code == 200, dl.text[:120])

        # No server-side thumbnails on the edge.
        r.check("png_has_thumb_false", p["has_thumb"] is False, str(p))
        r.check("png_dims", p["width"] == 1 and p["height"] == 1, str(p))
        r.check("png_no_stored_name", "stored_name" not in p, "stored_name leaked!")

        thumb = client.get(f"{base}/api/photos/{p['id']}/thumb", timeout=15)
        r.check("png_thumb_200", thumb.status_code == 200 and
                thumb.headers.get("content-type", "").startswith("image/"),
                f"{thumb.status_code} {thumb.headers.get('content-type')}")

        raw = client.get(f"{base}/api/photos/{p['id']}/raw", timeout=15)
        r.check("png_raw_bytes_intact", raw.status_code == 200 and raw.content[:8] == b"\x89PNG\r\n\x1a\n",
                f"{raw.status_code}")

        # download under BOTH phone user-agents — must be an attachment
        for ua_name, ua in (("iphone", IPHONE_UA), ("android", ANDROID_UA)):
            dl = client.get(f"{base}/api/photos/{p['id']}/download",
                            headers={"User-Agent": ua}, timeout=15)
            cd = dl.headers.get("content-disposition", "")
            r.check(f"png_download_attachment_{ua_name}",
                    dl.status_code == 200 and "attachment" in cd and "cat.png" in cd,
                    f"{dl.status_code} cd={cd!r}")
            r.check(f"png_download_ctype_{ua_name}",
                    dl.headers.get("content-type", "").startswith("image/"),
                    dl.headers.get("content-type", ""))

    # 2) real JPEG
    resp = upload(client, base, _real_jpeg(), f"r{rnd}_beach.jpg", "image/jpeg")
    r.check("jpeg_upload_200", resp.status_code == 200, f"{resp.status_code} {resp.text[:120]}")
    if resp.status_code == 200:
        jp = resp.json()["photos"][0]
        created_ids.append(jp["id"])
        r.check("jpeg_ctype", jp["content_type"] == "image/jpeg", str(jp))

    # 3) iPhone HEIC container — ACCEPTED + downloadable even though un-thumbnailable
    resp = upload(client, base, HEIC_HEADER, f"r{rnd}_IMG_0001.heic", "image/heic")
    r.check("heic_upload_200", resp.status_code == 200, f"{resp.status_code} {resp.text[:160]}")
    if resp.status_code == 200:
        hp = resp.json()["photos"][0]
        created_ids.append(hp["id"])
        r.check("heic_ctype", hp["content_type"] == "image/heic", str(hp))
        dl = client.get(f"{base}/api/photos/{hp['id']}/download", timeout=15)
        r.check("heic_downloadable", dl.status_code == 200, f"{dl.status_code}")
        thumb = client.get(f"{base}/api/photos/{hp['id']}/thumb", timeout=15)
        r.check("heic_thumb_fallback_200", thumb.status_code == 200, f"{thumb.status_code}")

    # 4) optional WEBP
    webp = _real_webp()
    if webp:
        resp = upload(client, base, webp, f"r{rnd}_art.webp", "image/webp")
        r.check("webp_upload_200", resp.status_code == 200, f"{resp.status_code}")
        if resp.status_code == 200:
            created_ids.append(resp.json()["photos"][0]["id"])

    # 5) GIF
    resp = upload(client, base, GIF_1x1, f"r{rnd}_anim.gif", "image/gif")
    r.check("gif_upload_200", resp.status_code == 200, f"{resp.status_code}")
    if resp.status_code == 200:
        created_ids.append(resp.json()["photos"][0]["id"])

    # 6) security: plain text rejected
    resp = upload(client, base, b"this is not an image", f"r{rnd}_notes.txt", "text/plain")
    r.check("reject_text_400", resp.status_code == 400, f"{resp.status_code}")

    # 7) security: text disguised as PNG rejected (magic-byte sniff, not ctype)
    resp = upload(client, base, b"<html>nope</html>", f"r{rnd}_fake.png", "image/png")
    r.check("reject_disguised_400", resp.status_code == 400, f"{resp.status_code}")

    # 8) partial batch: 1 good + 1 bad -> 200 with both buckets
    resp = client.post(f"{base}/api/photos", files=[
        ("files", (f"r{rnd}_good.png", PNG_1x1, "image/png")),
        ("files", (f"r{rnd}_bad.txt", b"nope", "text/plain")),
    ], timeout=30)
    r.check("partial_batch_200", resp.status_code == 200, f"{resp.status_code} {resp.text[:120]}")
    if resp.status_code == 200:
        body = resp.json()
        r.check("partial_one_ok", len(body["photos"]) == 1, str(body))
        r.check("partial_one_err", len(body.get("errors", [])) == 1, str(body))
        for q in body["photos"]:
            created_ids.append(q["id"])

    # 9) security: DELETE without the owner token is forbidden
    if created_ids:
        no_tok = client.delete(f"{base}/api/photos/{created_ids[0]}", timeout=15)
        r.check("delete_requires_owner_403", no_tok.status_code == 403, f"{no_tok.status_code}")

    # 10) listing reflects our uploads
    listed = client.get(f"{base}/api/photos", timeout=15).json()["photos"]
    listed_ids = {x["id"] for x in listed}
    r.check("all_listed", all(cid in listed_ids for cid in created_ids),
            f"missing {[c for c in created_ids if c not in listed_ids]}")

    # 11) cleanup: delete everything we created (with the owner token); confirm gone
    for cid in created_ids:
        d = delete(client, base, cid, token)
        r.check("delete_200", d.status_code == 200, f"{cid} -> {d.status_code}")
    for cid in created_ids:
        g = client.get(f"{base}/api/photos/{cid}/raw", timeout=15)
        r.check("deleted_404", g.status_code == 404, f"{cid} -> {g.status_code}")

    # 12) missing-id paths 404
    for suf in ("raw", "thumb", "download"):
        g = client.get(f"{base}/api/photos/doesnotexist/{suf}", timeout=15)
        r.check(f"missing_{suf}_404", g.status_code == 404, f"{g.status_code}")


def check_frontend(wall_js: Path, r: Results) -> None:
    """The phone-aware save path must be present in the shipped wall.js."""
    try:
        src = wall_js.read_text(encoding="utf-8")
    except Exception as e:
        r.check("wall_js_readable", False, f"{wall_js}: {e}")
        return
    r.check("wall_js_readable", True)
    r.check("wall_js_web_share", "navigator.share" in src and "canShare" in src,
            "Web Share save path missing")
    r.check("wall_js_anchor_fallback", "a.download" in src, "anchor download fallback missing")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8787")
    ap.add_argument("--owner-token", default="test-owner-secret")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--wall-js", default=str(Path(__file__).resolve().parents[2] / "wall.js"))
    args = ap.parse_args()

    r = Results()
    print(f"== Photo Wall UAT == base={args.base} rounds={args.rounds}")
    check_frontend(Path(args.wall_js), r)

    with httpx.Client(follow_redirects=True) as client:
        try:
            start_n = len(client.get(f"{args.base}/api/photos", timeout=15).json()["photos"])
        except Exception as e:
            print(f"   FATAL: cannot reach {args.base}/api/photos: {e}")
            return 2
        print(f"   baseline photos on wall: {start_n}")

        for rnd in range(1, args.rounds + 1):
            t0 = time.time()
            round_once(client, args.base, args.owner_token, r, rnd)
            print(f"   round {rnd} done in {time.time() - t0:.1f}s "
                  f"(pass={r.passed} fail={r.failed})")

        end_n = len(client.get(f"{args.base}/api/photos", timeout=15).json()["photos"])
        r.check("no_residue", end_n == start_n, f"start={start_n} end={end_n}")

    print(f"\n== RESULT: {r.passed} passed, {r.failed} failed ==")
    if r.fails:
        print("Failures:")
        for f in r.fails:
            print("  -", f)
    return 0 if r.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
