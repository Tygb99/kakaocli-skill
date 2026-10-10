#!/usr/bin/env python3
"""이미 열린 카카오톡 채팅 창에 글을 넣어 보내고, kakaocli DB에서 내 메시지로 전송을 확인한다.

사용: kakao-send.py --window <창 제목> --chat-id <CHAT_ID> --file <글.txt> [--me <내 USER_ID>] [--dry-run]
  --window  : 채팅 창 제목(방 이름). 창이 열려 있어야 한다 — 이 스크립트는 창을 열지 않는다.
  --me      : 내 user id. 없으면 KAKAO_USER_ID(환경변수 또는 KAKAO_ENV_FILE). 실제 전송 확인에만 쓴다.
  --dry-run : 입력칸에 글을 넣어 값이 같은지 보고 바로 지운다. 보내지 않는다.
열쇠·DB 경로는 kakao_db.py와 같은 규칙(KAKAO_DB_KEY·KAKAO_DB_PATH·KAKAO_ENV_FILE)으로 읽는다.
끝 줄: SENT_OK <KST 시각> | DRYRUN_OK | FAIL <단계>   (종료 코드 0이면 성공)
권한: 손쉬운 사용(System Events), 전체 디스크 접근(DB 확인).
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kakao_db  # noqa: E402


def ui(title: str, path: str, mode: str) -> dict[str, object]:
    r = subprocess.run(['osascript', '-l', 'JavaScript', os.path.join(HERE, 'kakao-send-ui.js'), title, path, mode],
                       capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return {'ok': False, 'step': 'UI_ERROR', 'stderr': r.stderr[:200]}


def main() -> int:
    ap = argparse.ArgumentParser(description='열린 카카오톡 채팅 창으로 보내고 DB로 확인한다')
    ap.add_argument('--window', required=True)
    ap.add_argument('--chat-id', required=True, type=int)
    ap.add_argument('--file', required=True)
    ap.add_argument('--me', type=int, help='내 user id (없으면 KAKAO_USER_ID)')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    msg = open(a.file, encoding='utf-8').read()
    path = os.path.abspath(a.file)

    if a.dry_run:
        res = ui(a.window, path, 'set')
        print(json.dumps(res, ensure_ascii=False))
        if not res.get('ok'):
            # BOX_NOT_EMPTY 등: 우리가 넣은 글이 아니므로 지우지 않는다
            print(f"FAIL {res.get('step')}")
            return 1
        cl = ui(a.window, path, 'clear')
        print(json.dumps(cl, ensure_ascii=False))
        if not cl.get('ok'):
            print('FAIL CLEAR')
            return 1
        print('DRYRUN_OK')
        return 0

    me = a.me or kakao_db.env_val('KAKAO_USER_ID')
    if not me:
        print('FAIL NO_USER_ID (--me 또는 KAKAO_USER_ID)')
        return 1
    try:
        key = kakao_db.derive_key(me)
    except RuntimeError as e:
        print(f'FAIL KEY {e}')
        return 1
    start = int(time.time()) - 2
    res = ui(a.window, path, 'send')
    print(json.dumps(res, ensure_ascii=False))
    if not res.get('ok'):
        print(f"FAIL {res.get('step')}")
        return 1
    head = msg[:40]
    lit = head.replace("'", "''")
    for _ in range(15):
        rows = kakao_db.q(key, f"SELECT sentAt FROM NTChatMessage WHERE chatId={a.chat_id} AND authorId={int(me)} "
                               f"AND sentAt>={start} AND substr(message,1,{len(head)})='{lit}' "
                               f"ORDER BY sentAt DESC LIMIT 1")
        if rows:
            print('SENT_OK', time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(rows[0][0] + 9 * 3600)))
            return 0
        time.sleep(1)
    print('FAIL NOT_IN_DB', 'box_after', res.get('boxAfter'))
    return 1


if __name__ == '__main__':
    sys.exit(main())
