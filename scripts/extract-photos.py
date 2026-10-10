#!/usr/bin/env python3
"""카카오톡 채팅 사진을 NTChatMessage에서 방·발신자·시각과 함께 원본으로 되받는다.

이 방식의 근거:
- 로컬 `fsCachedData/<UUID>`는 암호화돼 못 푼다.
- `Cache.db`의 CDN URL(open.kakaocdn.net/dn)은 프로필 이미지와 사진을 같은 호스트에 두어 서로 섞이고 방·발신자도 붙일 수 없다.
- `NTChatMessage.type=2`(단일 사진)·`type=27`(다중 사진)의 `attachment` JSON에는 원본 풀해상도 서명 URL이 있고, 같은 행의 `chatId`·`authorId`·`sentAt`으로 방·발신자·시각을 붙인다.

한계 — 서명 URL은 **사진 전송 후 약 4일**만 유효하다(그 뒤 HTTP 410 Gone). 그보다 오래된 사진은 서명이 죽었고 로컬 캐시도 암호화라 프로그램으로는 못 받는다.

주의: HEAD 요청은 이 CDN에서 거짓 404를 준다. 반드시 GET(=curl 기본)으로 받는다.
시각: sentAt은 unix epoch(UTC 아님, 로컬 카톡 저장값) — SQL에서 '+9 hours'로 KST 변환.
"""
from __future__ import annotations

import argparse, csv, json, re, subprocess, sys, urllib.parse
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SKILL_DIR))
import kakao_db  # noqa: E402  열쇠·DB 경로는 KAKAO_DB_KEY·KAKAO_DB_PATH·KAKAO_USER_ID(또는 KAKAO_ENV_FILE)에서


def sh(cmd: list[str]) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.stdout


def get_key(user_id: str | None) -> str:
    try:
        return kakao_db.derive_key(user_id)
    except RuntimeError as e:
        sys.exit(str(e))


def query(key: str, sql: str):
    try:
        return kakao_db.q(key, sql)
    except (RuntimeError, json.JSONDecodeError) as e:
        sys.exit(f"query 실패:\n{str(e)[:400]}")


def urls_from_attachment(mtype: int, att: str) -> list[str]:
    try:
        a = json.loads(att)
    except Exception:
        return []
    if mtype == 27:
        return a.get("imageUrls", []) or []
    u = a.get("url")
    return [u] if u else []


def expires_left(url: str, now: int) -> int | None:
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    if "expires" not in q:
        return None
    return int(q["expires"][0]) - now


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chat-id", help="특정 방만 (없으면 전체 방)")
    ap.add_argument("--since", help="KST 'YYYY-MM-DD HH:MM:SS'")
    ap.add_argument("--until", help="KST 'YYYY-MM-DD HH:MM:SS'")
    ap.add_argument("--out", default="kakao_photos")
    ap.add_argument("--user-id", help="내 user id (없으면 KAKAO_USER_ID; KAKAO_DB_KEY가 있으면 필요 없음)")
    ap.add_argument("--limit", type=int, default=0, help="메시지 건수 상한(0=전체)")
    ap.add_argument("--list-only", action="store_true")
    ap.add_argument("--include-video", action="store_true", help="type=3 동영상도")
    args = ap.parse_args()

    key = get_key(args.user_id)
    now = int(sh(["date", "+%s"]).strip())

    types = "2,27" + (",3" if args.include_video else "")
    where = [f"m.type IN ({types})"]
    if args.chat_id:
        where.append(f"m.chatId = {int(args.chat_id)}")
    if args.since:
        where.append(f"datetime(m.sentAt,'unixepoch','+9 hours') >= '{args.since}'")
    if args.until:
        where.append(f"datetime(m.sentAt,'unixepoch','+9 hours') <= '{args.until}'")
    lim = f"LIMIT {int(args.limit)}" if args.limit else ""
    sql = f"""
        SELECT datetime(m.sentAt,'unixepoch','+9 hours') AS kst, m.chatId, m.type, m.logId,
               COALESCE(NULLIF((SELECT u.nickName FROM NTUser u WHERE u.userId=m.authorId LIMIT 1),''),
                        NULLIF((SELECT u.displayName FROM NTUser u WHERE u.userId=m.authorId LIMIT 1),''),
                        '(?)') AS name,
               m.attachment
        FROM NTChatMessage m
        WHERE {' AND '.join(where)}
        ORDER BY m.sentAt DESC {lim}
    """
    rows = query(key, sql)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    manifest = out / "manifest.csv"

    total = ok = expired = 0
    with open(manifest, "w", newline="") as mf:
        w = csv.writer(mf); w.writerow(["kst", "chatId", "sender", "logId", "idx", "http", "file", "url"])
        for kst, chat_id, mtype, log_id, name, att in rows:
            urls = urls_from_attachment(mtype, att)
            safe = re.sub(r"[^\w가-힣]", "", str(name))[:16] or "unknown"
            stamp = kst.replace(":", "").replace("-", "").replace(" ", "-")
            for i, url in enumerate(urls):
                total += 1
                left = expires_left(url, now)
                fname = f"{stamp}_{safe}_{log_id}_{i}.jpg"
                if args.list_only:
                    tag = "" if left is None else (" [만료]" if left < 0 else f" [{left//3600}h]")
                    print(f"  {kst}  {name}  chat={chat_id}{tag}")
                    w.writerow([kst, chat_id, name, log_id, i, "", fname, url]); continue
                if left is not None and left < 0:
                    expired += 1
                    w.writerow([kst, chat_id, name, log_id, i, "410-expired", "", url]); continue
                dest = out / fname
                code = sh(["curl", "-sS", "-L", "--max-time", "40", "-o", str(dest), "-w", "%{http_code}", url]).strip()
                if code == "200" and dest.exists() and dest.stat().st_size > 0:
                    ok += 1
                else:
                    if dest.exists(): dest.unlink()
                    if code == "410": expired += 1
                    else: print(f"  실패 {code}: {log_id}_{i}")
                w.writerow([kst, chat_id, name, log_id, i, code, fname if code == "200" else "", url])

    if args.list_only:
        print(f"목록: 메시지 {len(rows)}건, 이미지 {total}장")
    else:
        print(f"완료: {ok}/{total} 저장, 만료(410) {expired}장 → {out}")
    print(f"매니페스트: {manifest}")


if __name__ == "__main__":
    main()
