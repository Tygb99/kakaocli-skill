# kakaocli-skill

macOS 카카오톡 데스크톱의 로컬 DB를 [kakaocli](https://github.com/silver-flight-group/kakaocli)로 읽고, 이미 열린 채팅 창으로 글을 보내는 에이전트 스킬이다. 본문은 [`SKILL.md`](SKILL.md).

- user ID 자동탐지 실패 우회(브루트포스 복구)와 키 직접 유도
- 발신자 이름 조인, KST 변환, 사진 원본 받기
- 열쇠·DB 경로를 env에 두고 `--db`로 넘겨 조회를 0.1초대로
- 열린 채팅 창으로 보내고 DB로 전송 확인(`--dry-run` 지원)
- 오픈채팅 스레드 답장(`scope=3`, `threadId`) 판정

## 설치

```bash
git clone <이 저장소> ~/skills/kakaocli-auth
ln -s ~/skills/kakaocli-auth ~/.claude/skills/kakaocli-auth     # 쓰는 에이전트의 스킬 폴더에 맞춘다
```

## scripts/

| 파일 | 하는 일 |
|---|---|
| `pick-account-hash.sh` | plist에서 활성 계정 해시 하나 고르기 |
| `recover-uid.py` | 계정 해시로 user ID 복구(멀티코어) |
| `derive-key.py` | Device UUID + user ID → DB 열쇠 |
| `kakao_db.py` | env의 열쇠·DB 경로로 빠른 질의 (모듈·명령 겸용) |
| `kakao-send.py` + `kakao-send-ui.js` | 열린 채팅 창으로 보내고 DB로 확인 |
| `extract-photos.py` | 사진 메시지의 원본 URL로 받아 방·발신자·시각 붙이기 |

이 기기에서만 쓰는 값(user ID, 방 목록 등)은 `LOCAL.md`에 둔다. `.gitignore`로 저장소에서 빠진다. 열쇠는 env 파일(권한 600)에만 두고 저장소에 넣지 않는다.
