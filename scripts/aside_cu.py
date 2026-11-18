"""Aside Computer Use로 맥 앱을 뒤에서 누른다 — 접근성 누르기 동작이 없는 칸(카톡 이모티콘 창의 탭·칸)에만 쓴다.

`aside mcp --computer-use --app <번들 ID>`를 띄워 MCP(stdio)로 repl 도구를 부른다. 모델을 거치지 않는다(repl은 `computer` API만 있는
JavaScript 샌드박스). 카톡을 앞으로 띄우지 않고 진짜 마우스도 움직이지 않는다(2026-11-18 실측: 맨 앞 앱·창 순서 그대로).
필요한 것: Aside 앱과 CLI, Computer Use 켜짐(`aside settings computer-use enable`). 없으면 AsideError.
Aside는 MCP 서버마다 대화 목록에 「Aside CLI Computer Use」 세션을 하나 남긴다 — close()가 이번에 새로 생긴 세션을 보관(archive)한다.
"""
from __future__ import annotations

import json
import queue
import subprocess
import threading
import time


class AsideError(RuntimeError):
    pass


def _sessions() -> set[str]:
    try:
        r = subprocess.run(['aside', 'session', 'list'], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return set()
    return {ln.split('\t')[0] for ln in r.stdout.splitlines()[1:] if 'Aside CLI Computer Use' in ln}


class AsideCU:
    def __init__(self, bundle: str) -> None:
        self._before = _sessions()
        try:
            self._p = subprocess.Popen(['aside', 'mcp', '--computer-use', '--app', bundle], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        except OSError as e:
            raise AsideError(f'ASIDE_NOT_INSTALLED {e}') from e
        self._q: queue.Queue[str] = queue.Queue()
        out = self._p.stdout
        assert out is not None
        threading.Thread(target=lambda: [self._q.put(ln) for ln in out], daemon=True).start()
        self._n = 0
        self._call('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                                  'clientInfo': {'name': 'kakaocli-skill', 'version': '1'}}, wait=30)
        self._write({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def _write(self, msg: dict[str, object]) -> None:
        assert self._p.stdin is not None
        self._p.stdin.write(json.dumps(msg) + '\n')
        self._p.stdin.flush()

    def _call(self, method: str, params: dict[str, object], wait: float) -> dict[str, object]:
        self._n += 1
        self._write({'jsonrpc': '2.0', 'id': self._n, 'method': method, 'params': params})
        deadline = time.time() + wait
        while time.time() < deadline:
            try:
                line = self._q.get(timeout=0.5)
            except queue.Empty:
                if self._p.poll() is not None:
                    err = self._p.stderr.read()[:300] if self._p.stderr else ''
                    raise AsideError(f'ASIDE_EXITED {err}') from None
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get('id') == self._n:
                return msg
        raise AsideError(f'ASIDE_TIMEOUT {method}')

    def run(self, code: str, wait: float = 60) -> str:
        """repl에서 JavaScript를 돌리고 console.log로 찍힌 글을 돌려준다. 오류면 AsideError."""
        msg = self._call('tools/call', {'name': 'repl', 'arguments': {'code': code}}, wait)
        res = msg.get('result')
        if not isinstance(res, dict):
            raise AsideError(f'ASIDE_ERROR {str(msg.get("error"))[:200]}')
        text = '\n'.join(c.get('text', '') for c in res.get('content', []) if isinstance(c, dict))
        if res.get('isError'):
            raise AsideError(f'ASIDE_ERROR {text[:200]}')
        return text

    def close(self) -> None:
        try:
            if self._p.stdin:
                self._p.stdin.close()
            self._p.terminate()
            self._p.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self._p.kill()
        for sid in _sessions() - self._before:
            subprocess.run(['aside', 'session', 'archive', sid], capture_output=True, text=True, timeout=20, check=False)
