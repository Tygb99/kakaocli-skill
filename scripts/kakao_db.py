#!/usr/bin/env python3
"""카톡 DB 조회 — 열쇠와 DB 경로를 환경변수(또는 env 파일)에서 읽고, SQLCipher 라이브러리로 이 프로세스 안에서 연다.

값마다 찾는 순서:
  1. 환경변수 KAKAO_DB_KEY / KAKAO_DB_PATH / KAKAO_USER_ID
  2. KAKAO_ENV_FILE 이 가리키는 파일의 `이름=값` 줄 (권한 600 권장, 위치는 사용자가 정한다)

열쇠가 없으면 `kakaocli status`(15~60초)로 Device UUID를 읽어 derive-key.py로 만든다.
이때는 KAKAO_USER_ID(또는 user_id 인자)가 있어야 한다.
DB 경로가 없으면 `kakaocli status`의 Database name으로 찾는다(느리다).

왜 kakaocli query를 부르지 않나: kakaocli는 열쇠를 `--key` 인자로만 받는다(QueryCommand.swift).
인자는 프로세스 명령줄이라 실행되는 동안 ps·pgrep -f·활동 모니터에 열쇠 전문이 보인다
(2026-11-25 `pgrep -fl KakaoTalk` 출력에 찍혀 에이전트 세션 기록에 남았다).
그래서 kakaocli DatabaseReader.open과 같은 순서(읽기 전용 열기 → cipher_default_compatibility 3, 안 되면 4 →
PRAGMA KEY)를 libsqlcipher로 직접 한다. 결과 모양도 kakaocli query와 같다(값만 담긴 2차원 배열, NULL·BLOB은 "").

모듈로:   sys.path에 이 폴더를 넣고  from kakao_db import derive_key, q   (다른 DB는 query_db(경로, 열쇠, sql))
명령으로: python3 kakao_db.py "SELECT count(*) FROM NTChatMessage"
          결과 JSON 한 줄을 stdout에, 걸린 시간을 stderr에 낸다. 열쇠는 어디에도 출력하지 않는다.
"""
import ctypes
import ctypes.util
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CONTAINER_DB_DIR = os.path.expanduser(
    '~/Library/Containers/com.kakao.KakaoTalkMac/Data/Library/Application Support/com.kakao.KakaoTalkMac')


def env_val(name: str) -> str:
    v = os.environ.get(name, '')
    if v:
        return v
    f = os.environ.get('KAKAO_ENV_FILE', '')
    if not f:
        return ''
    try:
        with open(os.path.expanduser(f), encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if line.startswith('export '):
                    line = line[len('export '):]
                if line.startswith(name + '='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ''


def derive_key(user_id: object = None) -> str:
    k = env_val('KAKAO_DB_KEY')
    if k:
        return k
    uid = str(user_id or env_val('KAKAO_USER_ID'))
    if not uid:
        raise RuntimeError('열쇠가 없다: KAKAO_DB_KEY를 두거나 KAKAO_USER_ID(또는 user_id 인자)를 줘라')
    st = subprocess.run(['kakaocli', 'status'], capture_output=True, text=True, timeout=120).stdout
    m = re.search(r'Device UUID:\s*(\S+)', st)
    if not m:
        raise RuntimeError('kakaocli status에 Device UUID가 없다 (전체 디스크 접근 권한 확인)')
    r = subprocess.run([sys.executable, os.path.join(HERE, 'derive-key.py'), m.group(1), uid],
                       capture_output=True, text=True, timeout=60)
    k = r.stdout.strip()
    if r.returncode or not re.fullmatch(r'[0-9a-f]{256}', k):
        raise RuntimeError('키 유도 실패')
    return k


SQLITE_OK, SQLITE_ROW, SQLITE_DONE = 0, 100, 101
SQLITE_INTEGER, SQLITE_FLOAT, SQLITE_TEXT = 1, 2, 3
OPEN_FLAGS = 0x00000001 | 0x00008000  # SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX (kakaocli와 같다)
_lib = None
_compat: dict = {}  # DB 경로 → 열린 cipher 호환 모드(다음엔 그것부터)


def _sqlcipher():
    global _lib
    if _lib is not None:
        return _lib
    cands = [os.environ.get('KAKAO_SQLCIPHER_LIB', ''), '/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib',
             '/usr/local/opt/sqlcipher/lib/libsqlcipher.dylib', ctypes.util.find_library('sqlcipher') or '']
    path = next((p for p in cands if p and os.path.exists(p)), '')
    if not path:
        raise RuntimeError('libsqlcipher를 못 찾았다 (brew install sqlcipher, 또는 KAKAO_SQLCIPHER_LIB)')
    lib = ctypes.CDLL(path)
    vp, cp, i = ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int
    for name, args, res in (
            ('sqlite3_open_v2', [cp, ctypes.POINTER(vp), i, cp], i),
            ('sqlite3_close', [vp], i),
            ('sqlite3_busy_timeout', [vp, i], i),
            ('sqlite3_exec', [vp, cp, vp, vp, vp], i),
            ('sqlite3_errmsg', [vp], cp),
            ('sqlite3_prepare_v2', [vp, cp, i, ctypes.POINTER(vp), vp], i),
            ('sqlite3_step', [vp], i),
            ('sqlite3_finalize', [vp], i),
            ('sqlite3_column_count', [vp], i),
            ('sqlite3_column_type', [vp, i], i),
            ('sqlite3_column_int64', [vp, i], ctypes.c_int64),
            ('sqlite3_column_double', [vp, i], ctypes.c_double),
            ('sqlite3_column_text', [vp, i], vp)):
        fn = getattr(lib, name)
        fn.argtypes, fn.restype = args, res
    _lib = lib
    return lib


def _errmsg(lib, h) -> str:
    m = lib.sqlite3_errmsg(h) if h else None
    return m.decode('utf-8', 'replace') if m else 'unknown'


def _open(lib, db: str, key: str):
    pragma_key = ("PRAGMA KEY='" + key.replace("'", "''") + "'").encode()
    for compat in sorted((3, 4), key=lambda m: m != _compat.get(db)):
        h = ctypes.c_void_p()
        if lib.sqlite3_open_v2(db.encode(), ctypes.byref(h), OPEN_FLAGS, None) != SQLITE_OK:
            msg = _errmsg(lib, h)
            lib.sqlite3_close(h)
            raise RuntimeError(f'DB 열기 실패: {msg}')
        lib.sqlite3_busy_timeout(h, 5000)
        if all(lib.sqlite3_exec(h, s, None, None, None) == SQLITE_OK for s in (
                f'PRAGMA cipher_default_compatibility = {compat}'.encode(), pragma_key,
                b'SELECT count(*) FROM sqlite_master')):
            _compat[db] = compat
            return h
        lib.sqlite3_close(h)
    _compat.pop(db, None)
    raise RuntimeError('PRAGMA key 실패(호환 3·4 모두) — 열쇠가 틀렸거나 카톡이 다시 설치됐다(SKILL.md §7-1)')


def query_db(db: str, key: str, sql: str) -> list:
    """SQLCipher DB를 읽기 전용으로 열어 sql 한 문장을 돌린다. 열쇠는 이 프로세스 밖으로 나가지 않는다."""
    lib = _sqlcipher()
    h = _open(lib, db, key)
    st = ctypes.c_void_p()
    try:
        if lib.sqlite3_prepare_v2(h, sql.encode(), -1, ctypes.byref(st), None) != SQLITE_OK:
            raise RuntimeError(f'prepare: {_errmsg(lib, h)}')
        if not st.value:  # 빈 문장
            return []
        n = lib.sqlite3_column_count(st)
        rows = []
        while True:
            rc = lib.sqlite3_step(st)
            if rc == SQLITE_DONE:
                return rows
            if rc != SQLITE_ROW:
                raise RuntimeError(f'step {rc}: {_errmsg(lib, h)}')
            row: list = []
            for c in range(n):
                t = lib.sqlite3_column_type(st, c)
                if t == SQLITE_INTEGER:
                    row.append(lib.sqlite3_column_int64(st, c))
                elif t == SQLITE_FLOAT:
                    row.append(lib.sqlite3_column_double(st, c))
                elif t == SQLITE_TEXT:
                    p = lib.sqlite3_column_text(st, c)
                    row.append(ctypes.string_at(p).decode('utf-8', 'replace') if p else '')
                else:
                    row.append('')
            rows.append(row)
    finally:
        lib.sqlite3_finalize(st)
        lib.sqlite3_close(h)


def find_db_path() -> str:
    st = subprocess.run(['kakaocli', 'status'], capture_output=True, text=True, timeout=120).stdout
    m = re.search(r'Database name:\s*(\S+)', st)
    p = os.path.join(CONTAINER_DB_DIR, m.group(1)) if m else ''
    if not p or not os.path.exists(p):
        raise RuntimeError('DB 파일을 못 찾았다: KAKAO_DB_PATH를 두거나 kakaocli status의 Database name 확인')
    return p


def db_path() -> str:
    db = os.path.expanduser(env_val('KAKAO_DB_PATH'))
    return db if db and os.path.exists(db) else find_db_path()


def q(key: str, sql: str) -> list:
    return query_db(db_path(), key, sql)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    t = time.time()
    try:
        rows = q(derive_key(), sys.argv[1])
    except RuntimeError as e:
        print(f'FAIL {e}', file=sys.stderr)
        return 1
    print(json.dumps(rows, ensure_ascii=False))
    print(f'# {time.time() - t:.2f}s', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
