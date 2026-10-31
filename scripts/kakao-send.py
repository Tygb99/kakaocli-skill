#!/usr/bin/env python3
"""카카오톡 채팅 창에 글·사진·파일·답장·멘션을 보내고, kakaocli DB에서 내 메시지로 전송을 확인한다.

사용: kakao-send.py --window <창 제목> --chat-id <CHAT_ID> [--file <글.txt>] [--photo <사진>]... [--attach <파일>]...
                    [--reply-to <원글 logId>] [--mention <이름>]... [--open] [--open-hint <말>]
                    [--bundle-id <번들 ID>] [--pid <PID>] [--me <내 USER_ID>] (--send | --dry-run)
      kakao-send.py --window <창 제목> --open-only [--open-hint <말>] [--bundle-id …] [--pid …]
  --send      : 실제로 보낸다. --send도 --dry-run도 없으면 미리보기만 한다(보낼 곳·글·파일을 찍고 종료 코드 2, 카톡을 건드리지 않음).
  --dry-run   : 글은 입력칸에 넣었다 지우고, 사진·파일은 확인 시트(「N개 전송」)까지 가서 취소하고, 답장은 열어 글을 넣었다가
                비우고 닫는다. 보내지 않는다. 답장·멘션 dry-run은 끝나고 DB에 내 새 글이 생겼는지 다시 본다(FAIL LEAKED).
  --window    : 채팅 창 제목(방 이름, 나와의 채팅은 내 이름).
  --open      : 창이 닫혀 있으면(WINDOW_NOT_OPEN) 본창 채팅 목록에서 그 방을 한 번 열고 이어 간다(kakao-open-ui.js).
                열면 그 방의 안 읽은 글이 읽음 처리된다. 못 열면 FAIL WINDOW_OPEN_FAILED <이유>.
  --open-only : 창만 열고 아무것도 보내지 않는다. 끝 줄 OPEN_OK <제목> <OPENED|ALREADY_OPEN>.
  --open-hint : 목록에 같은 이름의 방이 여럿일 때 줄 미리보기 글에 든 말로 하나를 고른다.
  --file      : 보낼 글이 든 텍스트 파일.
  --photo     : 보낼 사진(여러 번 쓸 수 있다). DB에서 type 2(사진)·27(여러 장)로 확인한다.
  --attach    : 보낼 파일(여러 번 쓸 수 있다). DB에서 type 18(파일)로 확인한다.
                글·사진·파일은 적은 순서대로 보낸다. 같은 종류가 이어지면 한 번에 붙인다 — 사진 여러 장은 「사진 N장」 묶음(type 27).
  --reply-to  : 그 logId 글에 「답장」(1:1·일반방) 또는 「댓글」(오픈채팅)으로 --file 글을 보낸다(kakao-reply-ui.js).
                원글은 DB에서 내용·작성자를 읽어 화면 말풍선과 맞춘다 — 글자 글만, 같은 내용이 그 방에 둘 이상이면 멈춘다.
                판정: 새 글이 type 26 + attachment.src_logId=원글, 또는 scope 3 + threadId=원글이면 REPLY_OK.
                보통 글로 나갔으면 FAIL REPLY_NOT_LINKED(다시 보내지 않는다).
  --mention   : --file 글 맨 앞에 진짜 멘션을 붙인다(여러 번 쓸 수 있다, kakao-mention-ui.js). 이름은 그 방에 보이는 이름 그대로.
                같은 이름이 둘 이상이거나 없으면 FAIL MENTION_AMBIGUOUS·MENTION_NOT_FOUND. 전송 뒤 DB attachment.mentions를 본다.
                --reply-to와 같이 쓰면 답장 열기 → 멘션 칩 → 글 순서.
                --reply-to·--mention은 --file 하나와만 쓴다(사진·파일과 섞지 않는다).
  --bundle-id : 대상 카카오톡 앱의 번들 ID(기본 com.kakao.KakaoTalkMac). 복제한 앱이면 그 번들 ID.
  --pid       : 대상 앱 PID. 주면 그 PID 하나만 건드리고, 그 PID의 번들 ID가 --bundle-id와 다르면 멈춘다.
                (UI 스크립트에는 환경변수 KAKAO_BUNDLE_ID·KAKAO_PID로 넘긴다.)
  --me        : 내 user id. 없으면 KAKAO_USER_ID(환경변수 또는 KAKAO_ENV_FILE). 전송 확인·답장 원글 확인·새 글 검사에 쓴다.
사진·파일은 1장·1개여도 클립보드로 붙인다(kakao-clip-ui.js): 카톡을 몇 초 앞으로 띄워 「편집 → 붙여넣기」하고,
끝나면 쓰던 앱과 원래 클립보드를 되돌린다. 붙여넣기는 ~/Downloads 아래 파일만 받으므로 다른 곳의 파일은
~/Downloads에 같은 이름으로 잠깐 복사하고 끝나면 지운다. 같은 이름의 다른 파일이 있으면 덮지 않고 멈춘다(STAGE_CONFLICT).
열쇠·DB 경로는 kakao_db.py와 같은 규칙(KAKAO_DB_KEY·KAKAO_DB_PATH·KAKAO_ENV_FILE)으로 읽는다.
끝 줄: SENT_OK <KST> | REPLY_OK logId=… to=… | DRYRUN_OK | OPEN_OK … | PREVIEW_ONLY | FAIL <단계>   (종료 코드 0이면 성공)
권한: 손쉬운 사용(System Events), 전체 디스크 접근(DB 확인).
"""
from __future__ import annotations

import argparse
import filecmp
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kakao_db  # noqa: E402

DOWNLOADS = os.path.expanduser('~/Downloads')
TYPES = {'photo': (2, 27), 'attach': (18,)}
PENDING = 9223372036854775807  # 보내는 중인 글의 임시 logId(INT64 최대) — 확인할 때 뺀다


def osa(script: str, *args: str, timeout: int = 90) -> dict[str, object]:
    try:
        r = subprocess.run(['osascript', '-l', 'JavaScript', os.path.join(HERE, script), *args],
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {'ok': False, 'step': 'UI_TIMEOUT'}
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return {'ok': False, 'step': 'UI_ERROR', 'stderr': r.stderr[:200]}


def ui(title: str, path: str, mode: str) -> dict[str, object]:
    return osa('kakao-send-ui.js', title, path, mode)


def open_window(a: argparse.Namespace) -> dict[str, object]:
    return osa('kakao-open-ui.js', a.window, 'open', a.open_hint or '')


def with_window(a: argparse.Namespace, call, lines: list[str]) -> dict[str, object]:
    """창이 닫혀 있고 --open이면 한 번 열고 같은 호출을 다시 한다."""
    res = call()
    if res.get('step') != 'WINDOW_NOT_OPEN' or not a.open:
        return res
    opened = open_window(a)
    lines.append(json.dumps(opened, ensure_ascii=False))
    if not opened.get('ok'):
        return {'ok': False, 'step': f"WINDOW_OPEN_FAILED {opened.get('step')}"}
    return call()


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


def sql_str(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def preview(a: argparse.Namespace, items: list[tuple[str, str]]) -> int:
    """--send 없이 돌리면 보낼 것만 찍고 아무것도 건드리지 않는다(남에게 닿는 스크립트는 기본이 미리보기)."""
    print(f'PREVIEW 보낼 곳: 창 「{a.window}」 chat {a.chat_id}' + (f' (닫혀 있으면 연다)' if a.open else ''))
    if a.reply_to:
        print(f'PREVIEW 답장할 원글 logId: {a.reply_to}')
    for n in a.mention:
        print(f'PREVIEW 멘션: {n}')
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
    ap = argparse.ArgumentParser(description='카카오톡 채팅 창으로 보내고 DB로 확인한다')
    ap.add_argument('--window', required=True)
    ap.add_argument('--chat-id', type=int)
    ap.add_argument('--file', dest='items', action='append', type=lambda s: ('text', s), help='보낼 글 파일')
    ap.add_argument('--photo', dest='items', action='append', type=lambda s: ('photo', s), help='보낼 사진')
    ap.add_argument('--attach', dest='items', action='append', type=lambda s: ('attach', s), help='보낼 파일')
    ap.add_argument('--reply-to', type=int, metavar='logId', help='이 글에 답장으로 보낸다(--file 하나와만)')
    ap.add_argument('--mention', action='append', default=[], metavar='이름', help='글 맨 앞에 진짜 멘션(여러 번)')
    ap.add_argument('--open', action='store_true', help='창이 닫혀 있으면 본창 목록에서 연다')
    ap.add_argument('--open-only', action='store_true', help='창만 열고 보내지 않는다')
    ap.add_argument('--open-hint', default='', help='같은 이름 방이 여럿일 때 미리보기 글로 고르는 말')
    ap.add_argument('--bundle-id', help='대상 앱 번들 ID(기본 com.kakao.KakaoTalkMac)')
    ap.add_argument('--pid', type=int, help='대상 앱 PID(번들 ID가 다르면 멈춘다)')
    ap.add_argument('--me', type=int, help='내 user id (없으면 KAKAO_USER_ID)')
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--send', action='store_true', help='실제로 보낸다(없으면 미리보기)')
    mode.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    if a.bundle_id:
        os.environ['KAKAO_BUNDLE_ID'] = a.bundle_id
    if a.pid:
        os.environ['KAKAO_PID'] = str(a.pid)

    if a.open_only:
        if a.items or a.reply_to or a.mention:
            ap.error('--open-only는 보낼 것과 같이 쓰지 않는다')
        res = open_window(a)
        print(json.dumps(res, ensure_ascii=False))
        if not res.get('ok'):
            print(f"FAIL {res.get('step')}")
            return 1
        print(f"OPEN_OK {a.window} {res.get('step')}")
        return 0

    if a.chat_id is None:
        ap.error('--chat-id가 있어야 한다')
    if not a.items:
        ap.error('--file·--photo·--attach 중 하나는 있어야 한다')
    special = bool(a.reply_to or a.mention)
    if special and (len(a.items) != 1 or a.items[0][0] != 'text'):
        ap.error('--reply-to·--mention은 --file 하나와만 쓴다')
    for _, p in a.items:
        if not os.path.isfile(p):
            print(f'FAIL NO_SUCH_FILE {p}')
            return 1
    if not a.send and not a.dry_run:
        return preview(a, a.items)

    key, me = '', 0
    if a.send or special:
        me = int(a.me or kakao_db.env_val('KAKAO_USER_ID') or 0)
        if not me:
            print('FAIL NO_USER_ID (--me 또는 KAKAO_USER_ID)')
            return 1
        try:
            key = kakao_db.derive_key(me)
        except RuntimeError as e:
            print(f'FAIL KEY {e}')
            return 1

    if special:
        text = open(a.items[0][1], encoding='utf-8').read()
        if a.reply_to:
            ok, lines = send_reply(a, text, key, me)
        else:
            ok, lines = send_mention(a, text, key, me)
        print('\n'.join(lines))
        return 0 if ok else 1

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
    lines: list[str] = []
    if a.dry_run:
        res = with_window(a, lambda: ui(a.window, path, 'set'), lines)
        print('\n'.join(lines + [json.dumps(res, ensure_ascii=False)]))
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
    res = with_window(a, lambda: ui(a.window, path, 'send'), lines)
    print('\n'.join(lines + [json.dumps(res, ensure_ascii=False)]))
    if not res.get('ok'):
        print(f"FAIL {res.get('step')}")
        return 1, ''
    head = msg[:40]
    for _ in range(15):
        rows = kakao_db.q(key, f"SELECT sentAt FROM NTChatMessage WHERE chatId={a.chat_id} AND authorId={me} "
                               f"AND sentAt>={start} AND logId<{PENDING} AND substr(message,1,{len(head)})={sql_str(head)} "
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
    lines: list[str] = []
    try:
        if a.dry_run:
            res = with_window(a, lambda: osa('kakao-clip-ui.js', a.window, 'check', *staged), lines)
            print('\n'.join(lines + [json.dumps(res, ensure_ascii=False)]))
            if not res.get('ok'):
                print(f"FAIL {res.get('step')}")
                return 1, ''
            return 0, ''

        types = TYPES[kind]
        before = max_log(a, key)
        start = int(time.time()) - 2
        res = with_window(a, lambda: osa('kakao-clip-ui.js', a.window, 'send', *staged), lines)
        print('\n'.join(lines + [json.dumps(res, ensure_ascii=False)]))
        if not res.get('ok'):
            print(f"FAIL {res.get('step')}")
            return 1, ''
        for _ in range(30):
            rows = kakao_db.q(key, f"SELECT logId, type, sentAt, message FROM NTChatMessage WHERE chatId={a.chat_id} "
                                   f"AND authorId={me} AND sentAt>={start} AND logId>{before} AND logId<{PENDING} "
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


def max_log(a: argparse.Namespace, key: str) -> int:
    return int(kakao_db.q(key, f"SELECT coalesce(max(logId),0) FROM NTChatMessage WHERE chatId={a.chat_id} "
                               f"AND logId<{PENDING}")[0][0])


def my_new(a: argparse.Namespace, key: str, me: int, before: int) -> list[list[Any]]:
    return kakao_db.q(key, f"SELECT logId, type, scope, threadId, coalesce(attachment,''), coalesce(message,''), sentAt "
                           f"FROM NTChatMessage WHERE chatId={a.chat_id} AND authorId={me} AND logId>{before} "
                           f"AND logId<{PENDING} ORDER BY logId")


def leaked(a: argparse.Namespace, key: str, me: int, before: int, lines: list[str]) -> bool:
    """보내지 않아야 할 때(dry-run·실패) 내 새 글이 생겼는지 DB로 본다."""
    time.sleep(3)
    new = my_new(a, key, me, before)
    if new:
        lines.append(f'FAIL LEAKED {new[0][0]} — 보내지 않아야 했는데 내 새 글 {len(new)}개: {str(new[0][5])[:40]!r}')
        return True
    lines.append(f'DB_CHECK my_new=0 (logId>{before})')
    return False


def mention_ui(a: argparse.Namespace, path: str, mode: str) -> dict[str, object]:
    return osa('kakao-mention-ui.js', a.window, path, mode, *a.mention, timeout=30 + 15 * len(a.mention))


def mention_lines(att: str, want: int, lines: list[str], log_id: object) -> bool:
    try:
        got = json.loads(att).get('mentions') or []
    except (json.JSONDecodeError, AttributeError):
        got = []
    for m in got:
        lines.append(f"MENTION_OK user_id={m.get('user_id')} len={m.get('len')} at={m.get('at')}")
    if len(got) != want:
        lines.append(f'FAIL MENTION_NOT_IN_DB 글은 나갔다(logId {log_id}) — mentions {len(got)}개, 기대 {want}개')
        return False
    return True


def send_mention(a: argparse.Namespace, text: str, key: str, me: int) -> tuple[bool, list[str]]:
    lines: list[str] = []
    with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False, encoding='utf-8') as f:
        f.write(text)
        path = f.name
    try:
        before = max_log(a, key)
        if a.dry_run:
            res = with_window(a, lambda: mention_ui(a, path, 'set'), lines)
            lines.append(json.dumps(res, ensure_ascii=False))
            if res.get('ok'):
                # 입력칸에 남은 값(칩 포함)과 똑같을 때만 kakao-send-ui.js clear가 비운다
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(str(res.get('value', '')))
                cleared = ui(a.window, path, 'clear')
                lines.append(json.dumps(cleared, ensure_ascii=False))
                if not cleared.get('ok'):
                    leaked(a, key, me, before, lines)
                    lines.append(f"FAIL CLEANUP {cleared.get('step')}")
                    return False, lines
            if leaked(a, key, me, before, lines):
                return False, lines
            lines.append('DRYRUN_OK' if res.get('ok') else f"FAIL {res.get('step')}")
            return bool(res.get('ok')), lines
        start = int(time.time()) - 2
        res = with_window(a, lambda: mention_ui(a, path, 'send'), lines)
        lines.append(json.dumps(res, ensure_ascii=False))
        if not res.get('ok'):
            if leaked(a, key, me, before, lines):
                return False, lines
            lines.append(f"FAIL {res.get('step')}")
            return False, lines
        head = text.strip()[:40]
        for _ in range(15):
            rows = kakao_db.q(key, f"SELECT logId, sentAt, message, coalesce(attachment,'') FROM NTChatMessage "
                                   f"WHERE chatId={a.chat_id} AND authorId={me} AND sentAt>={start} AND logId>{before} "
                                   f"AND logId<{PENDING} AND instr(message, {sql_str(head)})>0 ORDER BY logId DESC LIMIT 1")
            if rows:
                log_id, sent_at, message, att = rows[0]
                if not mention_lines(att, len(a.mention), lines, log_id):
                    return False, lines
                lines.append(f'TEXT logId={log_id} {str(message)[:80]!r}')
                lines.append('SENT_OK ' + kst(sent_at))
                return True, lines
            time.sleep(1)
        lines.append(f"FAIL NOT_IN_DB box_after {res.get('boxAfter')} — 다시 보내기 전에 DB로 그 방을 먼저 본다")
        return False, lines
    finally:
        os.unlink(path)


def reply_target(a: argparse.Namespace, key: str, me: int) -> dict[str, object]:
    rows = kakao_db.q(key, f"SELECT authorId, type, coalesce(message,''), sentAt FROM NTChatMessage "
                           f"WHERE chatId={a.chat_id} AND logId={a.reply_to}")
    if not rows:
        raise RuntimeError(f'REPLY_TARGET_NOT_FOUND {a.reply_to}')
    author, typ, message, sent_at = int(rows[0][0]), int(rows[0][1]), str(rows[0][2]), int(rows[0][3])
    if typ not in (1, 26) or not message.strip():
        raise RuntimeError(f'REPLY_TARGET_NOT_TEXT type={typ} (글자 글만 답장할 수 있다 — 지운 글은 type에 16384가 더해진다)')
    same = int(kakao_db.q(key, f"SELECT count(*) FROM NTChatMessage WHERE chatId={a.chat_id} "
                               f"AND message={sql_str(message)}")[0][0])
    if same > 1:
        raise RuntimeError(f'REPLY_TARGET_NOT_UNIQUE 같은 내용 {same}개')
    # 오픈채팅은 방(linkId)마다 이름이 다르다 — 그 방 linkId의 이름을 먼저, 없으면 아무 행이나
    link = kakao_db.q(key, f"SELECT coalesce(linkId,0) FROM NTChatRoom WHERE chatId={a.chat_id}")
    link_id = int(link[0][0]) if link else 0
    nm = kakao_db.q(key, f"SELECT COALESCE(NULLIF(nickName,''), NULLIF(displayName,''), NULLIF(friendNickName,''), '') "
                         f"FROM NTUser WHERE userId={author} ORDER BY (linkId={link_id}) DESC LIMIT 1")
    return {'text': message, 'author': nm[0][0] if nm else '', 'self': author == me, 'sentAt': kst(sent_at)}


def reply_ui(a: argparse.Namespace, mode: str, target_path: str, msg_path: str | None = None) -> dict[str, object]:
    return osa('kakao-reply-ui.js', a.window, mode, target_path, *([msg_path] if msg_path else []), timeout=240)


def reply_link(row: list[Any], log_id: int) -> str | None:
    _lid, _typ, scope, thread, att = row[:5]
    if int(scope or 0) == 3 and int(thread or 0) == int(log_id):
        return 'threadId'
    try:
        if int(json.loads(str(att)).get('src_logId') or 0) == int(log_id):
            return 'src_logId'
    except (json.JSONDecodeError, AttributeError, TypeError, ValueError):
        pass
    return None


def send_reply(a: argparse.Namespace, text: str, key: str, me: int) -> tuple[bool, list[str]]:
    lines: list[str] = []
    try:
        target = reply_target(a, key, me)
    except RuntimeError as e:
        return False, [f'FAIL {e}']
    lines.append(f"TARGET logId={a.reply_to} self={target['self']} at={target['sentAt']} {str(target['text'])[:40]!r}")
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump({k: target[k] for k in ('text', 'author', 'self')}, f, ensure_ascii=False)
        tpath = f.name
    with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False, encoding='utf-8') as f:
        f.write(text)
        mpath = f.name
    try:
        before = max_log(a, key)
        mode = 'set' if a.dry_run else 'send'
        if a.mention:
            res = with_window(a, lambda: reply_ui(a, 'open', tpath), lines)
            lines.append(json.dumps(res, ensure_ascii=False))
            if res.get('ok'):
                res = mention_ui(a, mpath, mode)
                lines.append(json.dumps(res, ensure_ascii=False))
        else:
            res = with_window(a, lambda: reply_ui(a, mode, tpath, mpath), lines)
            lines.append(json.dumps(res, ensure_ascii=False))
        if res.get('step') in ('REPLY_ALREADY_OPEN', 'BOX_NOT_EMPTY'):
            lines.append(f"FAIL {res.get('step')}")
            return False, lines
        if a.dry_run or not res.get('ok'):
            closed = reply_ui(a, 'close', tpath)
            lines.append(json.dumps(closed, ensure_ascii=False))
            if not closed.get('ok'):
                leaked(a, key, me, before, lines)
                lines.append(f"FAIL CLEANUP {closed.get('step')}")
                return False, lines
            if leaked(a, key, me, before, lines):
                return False, lines
            if not res.get('ok'):
                lines.append(f"FAIL {res.get('step')}")
                return False, lines
            lines.append('DRYRUN_OK')
            return True, lines
        head = text.strip()[:20]
        for _ in range(15):
            mine = [r for r in my_new(a, key, me, before) if head in str(r[5])]
            for row in mine:
                how = reply_link(row, a.reply_to)
                if not how:
                    continue
                lines.append(f'REPLY_LINK {how} type={row[1]} scope={row[2]} threadId={row[3]}')
                if a.mention and not mention_lines(str(row[4]), len(a.mention), lines, row[0]):
                    return False, lines
                lines.append(f'REPLY_OK logId={row[0]} to={a.reply_to}')
                return True, lines
            if mine:
                lines.append(f'FAIL REPLY_NOT_LINKED 글은 나갔다(logId {mine[0][0]}) — 답장 연결 없음 '
                             f'type={mine[0][1]} scope={mine[0][2]} threadId={mine[0][3]}')
                return False, lines
            time.sleep(1)
        lines.append(f"FAIL NOT_IN_DB box_after {res.get('boxAfter')} — 다시 보내기 전에 DB로 그 방을 먼저 본다")
        return False, lines
    finally:
        os.unlink(tpath)
        os.unlink(mpath)


if __name__ == '__main__':
    sys.exit(main())
