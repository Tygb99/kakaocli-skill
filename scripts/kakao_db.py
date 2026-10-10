#!/usr/bin/env python3
"""kakaocli 조회를 빠르게 — 열쇠와 DB 경로를 환경변수(또는 env 파일)에서 읽고 --db로 넘긴다.

값마다 찾는 순서:
  1. 환경변수 KAKAO_DB_KEY / KAKAO_DB_PATH / KAKAO_USER_ID
  2. KAKAO_ENV_FILE 이 가리키는 파일의 `이름=값` 줄 (권한 600 권장, 위치는 사용자가 정한다)

열쇠가 없으면 `kakaocli status`(15~60초)로 Device UUID를 읽어 derive-key.py로 만든다.
이때는 KAKAO_USER_ID(또는 user_id 인자)가 있어야 한다.
DB 경로가 없거나 --db 질의가 실패하면 --db 없이 다시 돌린다(질의마다 10초 이상 걸린다).

모듈로:   sys.path에 이 폴더를 넣고  from kakao_db import derive_key, q
명령으로: python3 kakao_db.py "SELECT count(*) FROM NTChatMessage"
          결과 JSON 한 줄을 stdout에, 걸린 시간을 stderr에 낸다. 열쇠는 어디에도 출력하지 않는다.
"""
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


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


def q(key: str, sql: str) -> list:
    db = os.path.expanduser(env_val('KAKAO_DB_PATH'))
    if db and os.path.exists(db):
        r = subprocess.run(['kakaocli', 'query', sql, '--db', db, '--key', key],
                           capture_output=True, text=True, timeout=240)
        if not r.returncode:
            return json.loads(r.stdout)
    r = subprocess.run(['kakaocli', 'query', sql, '--key', key], capture_output=True, text=True, timeout=240)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout).replace(key, '[KEY]')[:300])
    return json.loads(r.stdout)


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
