#!/usr/bin/env python3
"""이미 열린 카카오톡 채팅 창에 글·사진·파일을 보내고, kakaocli DB에서 내 메시지로 전송을 확인한다.

사용: kakao-send.py --window <창 제목> --chat-id <CHAT_ID> [--file <글.txt>] [--photo <사진>]... [--attach <파일>]...
                    [--me <내 USER_ID>] (--send | --dry-run)
  --send    : 실제로 보낸다. --send도 --dry-run도 없으면 미리보기만 한다(보낼 곳·글·파일을 찍고 종료 코드 2, 카톡을 건드리지 않음).
  --window  : 채팅 창 제목(방 이름). 창이 열려 있어야 한다 — 이 스크립트는 창을 열지 않는다.
  --file    : 보낼 글이 든 텍스트 파일.
  --photo   : 보낼 사진(여러 번 쓸 수 있다). DB에서 type 2(사진)·27(여러 장)로 확인한다.
  --attach  : 보낼 파일(여러 번 쓸 수 있다). DB에서 type 18(파일)로 확인한다.
              글·사진·파일은 적은 순서대로 보낸다. 같은 종류가 이어지면 한 번에 붙인다 — 사진 여러 장은 「사진 N장」 묶음(type 27).
  --me      : 내 user id. 없으면 KAKAO_USER_ID(환경변수 또는 KAKAO_ENV_FILE). 실제 전송 확인에만 쓴다.
  --dry-run : 글은 입력칸에 넣었다 지우고, 사진·파일은 확인 시트(「N개 전송」)까지 가서 취소한다. 보내지 않는다.
사진·파일은 1장·1개여도 클립보드로 붙인다(kakao-clip-ui.js): 카톡을 몇 초 앞으로 띄워 「편집 → 붙여넣기」하고,
끝나면 쓰던 앱과 원래 클립보드를 되돌린다. 「파일전송」 열기 창(kakao-attach-ui.js)은 쓰지 않는다.
붙여넣기는 ~/Downloads 아래 파일만 받으므로 다른 곳의 파일은 ~/Downloads에 같은 이름으로 잠깐 복사하고
끝나면 지운다(원래 ~/Downloads에 있던 파일은 그대로 쓰고 지우지 않는다).
같은 이름의 다른 파일이 ~/Downloads에 있으면 덮지 않고 멈춘다(STAGE_CONFLICT).
열쇠·DB 경로는 kakao_db.py와 같은 규칙(KAKAO_DB_KEY·KAKAO_DB_PATH·KAKAO_ENV_FILE)으로 읽는다.
끝 줄: SENT_OK <KST 시각> | DRYRUN_OK | PREVIEW_ONLY | FAIL <단계>   (종료 코드 0이면 성공)
권한: 손쉬운 사용(System Events), 전체 디스크 접근(DB 확인).
"""
import argparse
import filecmp
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kakao_db  # noqa: E402

DOWNLOADS = os.path.expanduser('~/Downloads')
TYPES = {'photo': (2, 27), 'attach': (18,)}


def osa(script: str, *args: str) -> dict[str, object]:
    r = subprocess.run(['osascript', '-l', 'JavaScript', os.path.join(HERE, script), *args],
                       capture_output=True, text=True, timeout=90)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return {'ok': False, 'step': 'UI_ERROR', 'stderr': r.stderr[:200]}


def ui(title: str, path: str, mode: str) -> dict[str, object]:
    return osa('kakao-send-ui.js', title, path, mode)


def stage(src: str) -> tuple[str, bool]:
    src = os.path.abspath(src)
    dst = os.path.join(DOWNLOADS, os.path.basename(src))
    if os.path.dirname(src) == DOWNLOADS:
        return dst, False
    if os.path.exists(dst):
        if filecmp.cmp(src, dst, shallow=False):
            return dst, False
        raise FileExistsError(dst)
    shutil.copy2(src, dst)
    return dst, True


def kst(sent_at: int) -> str:
    return time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(sent_at + 9 * 3600))


def preview(where: str, items: list[tuple[str, str]]) -> int:
    """--send 없이 돌리면 보낼 것만 찍고 아무것도 건드리지 않는다(남에게 닿는 스크립트는 기본이 미리보기)."""
    print(f'PREVIEW 보낼 곳: {where}')
    for kind, p in items:
        if kind == 'text':
            try:
                body = open(p, encoding='utf-8').read()
            except OSError as e:
                print(f'PREVIEW 글 {p}: 못 읽음 {e}')
                continue
            print(f"PREVIEW 글({len(body)}자): {body[:200].replace(chr(10), ' / ')}")
        else:
            print(f'PREVIEW {kind}: {p}')
    print('PREVIEW_ONLY 보내지 않았다 — 실제로 보내려면 --send, 입력칸 시험은 --dry-run')
    return 2


def main() -> int:
    ap = argparse.ArgumentParser(description='열린 카카오톡 채팅 창으로 보내고 DB로 확인한다')
    ap.add_argument('--window', required=True)
    ap.add_argument('--chat-id', required=True, type=int)
    ap.add_argument('--file', dest='items', action='append', type=lambda s: ('text', s), help='보낼 글 파일')
    ap.add_argument('--photo', dest='items', action='append', type=lambda s: ('photo', s), help='보낼 사진')
    ap.add_argument('--attach', dest='items', action='append', type=lambda s: ('attach', s), help='보낼 파일')
    ap.add_argument('--me', type=int, help='내 user id (없으면 KAKAO_USER_ID)')
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--send', action='store_true', help='실제로 보낸다(없으면 미리보기)')
    mode.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    if not a.items:
        ap.error('--file·--photo·--attach 중 하나는 있어야 한다')
    for _, p in a.items:
        if not os.path.isfile(p):
            print(f'FAIL NO_SUCH_FILE {p}')
            return 1
    if not a.send and not a.dry_run:
        return preview(f'창 「{a.window}」 chat {a.chat_id}', a.items)

    key, me = '', 0
    if not a.dry_run:
        me = int(a.me or kakao_db.env_val('KAKAO_USER_ID') or 0)
        if not me:
            print('FAIL NO_USER_ID (--me 또는 KAKAO_USER_ID)')
            return 1
        try:
            key = kakao_db.derive_key(me)
        except RuntimeError as e:
            print(f'FAIL KEY {e}')
            return 1

    groups: list[tuple[str, list[str]]] = []
    for kind, p in a.items:
        if kind != 'text' and groups and groups[-1][0] == kind:
            groups[-1][1].append(p)
        else:
            groups.append((kind, [p]))
    last = ''
    for kind, ps in groups:
        rc, last = send_text(a, kind, ps[0], key, me) if kind == 'text' else send_attachment(a, kind, ps, key, me)
        if rc:
            return rc
    print('DRYRUN_OK' if a.dry_run else f'SENT_OK {last}')
    return 0


def send_text(a: argparse.Namespace, _kind: str, p: str, key: str, me: int) -> tuple[int, str]:
    msg = open(p, encoding='utf-8').read()
    path = os.path.abspath(p)
    if a.dry_run:
        res = ui(a.window, path, 'set')
        print(json.dumps(res, ensure_ascii=False))
        if not res.get('ok'):
            # BOX_NOT_EMPTY 등: 우리가 넣은 글이 아니므로 지우지 않는다
            print(f"FAIL {res.get('step')}")
            return 1, ''
        cl = ui(a.window, path, 'clear')
        print(json.dumps(cl, ensure_ascii=False))
        if not cl.get('ok'):
            print('FAIL CLEAR')
            return 1, ''
        return 0, ''

    start = int(time.time()) - 2
    res = ui(a.window, path, 'send')
    print(json.dumps(res, ensure_ascii=False))
    if not res.get('ok'):
        print(f"FAIL {res.get('step')}")
        return 1, ''
    head = msg[:40]
    lit = head.replace("'", "''")
    for _ in range(15):
        rows = kakao_db.q(key, f"SELECT sentAt FROM NTChatMessage WHERE chatId={a.chat_id} AND authorId={me} "
                               f"AND sentAt>={start} AND substr(message,1,{len(head)})='{lit}' "
                               f"ORDER BY sentAt DESC LIMIT 1")
        if rows:
            print('TEXT_OK', kst(rows[0][0]))
            return 0, kst(rows[0][0])
        time.sleep(1)
    print('FAIL NOT_IN_DB', 'box_after', res.get('boxAfter'))
    return 1, ''


def send_attachment(a: argparse.Namespace, kind: str, paths: list[str], key: str, me: int) -> tuple[int, str]:
    copies: list[str] = []
    staged: list[str] = []
    try:
        for p in paths:
            dst, made = stage(p)
            staged.append(dst)
            if made:
                copies.append(dst)
    except FileExistsError as e:
        for c in copies:
            os.remove(c)
        print(f'FAIL STAGE_CONFLICT {e} (같은 이름의 다른 파일이 있다)')
        return 1, ''
    n = len(staged)
    keep = False
    try:
        if a.dry_run:
            res = osa('kakao-clip-ui.js', a.window, 'check', *staged)
            print(json.dumps(res, ensure_ascii=False))
            if not res.get('ok'):
                print(f"FAIL {res.get('step')}")
                return 1, ''
            return 0, ''

        types = TYPES[kind]
        before = kakao_db.q(key, f"SELECT coalesce(max(logId),0) FROM NTChatMessage WHERE chatId={a.chat_id}")[0][0]
        start = int(time.time()) - 2
        res = osa('kakao-clip-ui.js', a.window, 'send', *staged)
        print(json.dumps(res, ensure_ascii=False))
        if not res.get('ok'):
            print(f"FAIL {res.get('step')}")
            return 1, ''
        for _ in range(30):
            rows = kakao_db.q(key, f"SELECT logId, type, sentAt, message FROM NTChatMessage WHERE chatId={a.chat_id} "
                                   f"AND authorId={me} AND sentAt>={start} AND logId>{before} "
                                   f"ORDER BY logId")
            bad = [r for r in rows if r[1] not in types]
            if bad:
                print(f'FAIL TYPE_MISMATCH 보낸 것은 맞다(logId {bad[0][0]}) — type {bad[0][1]}, 기대 {types}')
                return 1, ''
            if any(r[1] == 27 for r in rows) or len(rows) >= n:
                for log_id, typ, sent_at, message in rows:
                    print(f'{kind.upper()}_OK type={typ} logId={log_id} {kst(sent_at)} {str(message)[:40]}')
                return 0, kst(rows[-1][2])
            time.sleep(1)
        keep = True
        print(f'FAIL NOT_IN_DB — 다시 보내기 전에 DB로 그 방을 먼저 본다. 복사본은 남겨 둔다: {copies}')
        return 1, ''
    finally:
        if not keep:
            for c in copies:
                if os.path.exists(c):
                    os.remove(c)


if __name__ == '__main__':
    sys.exit(main())
