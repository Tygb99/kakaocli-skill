# kakaocli-skill

> **본인 책임으로 쓴다.** 이 스킬은 카카오가 공식 지원하지 않는 방법(로컬 DB 복호화, 손쉬운 사용으로 화면 조작)을 쓴다. 결과는 사용자 본인 책임이다.
>
> **카톡 메시지 서버와는 직접 통신하지 않는다.** 읽기는 이 맥에 이미 있는 DB 파일만 연다. 보내기는 진짜 카카오톡 앱의 입력칸에 글을 넣고 전송 단추를 누르는 것이라, 서버가 보기에는 사람이 맥 카톡에서 직접 친 것과 같다. 카톡 서버 통신(LOCO 프로토콜)을 흉내 내지 않는다 — 알려진 계정 정지 경험담은 그 통신을 직접 흉내 낸 경우다. 그래서 서버가 이 스킬을 쓴다는 것 자체를 알아챌 길은 사실상 없다고 본다.
>
> **남는 위험은 사람이 직접 보내도 걸리는 기준이다.** 짧은 시간에 같은 글을 여러 방·여러 사람에게 많이 보내면 스팸으로 제한될 수 있다. 이 스킬에는 자동 반복 전송이 없고, 기본이 미리보기다(실제 전송은 `--send`). 사진 받기(`extract-photos.py`)는 앱이 받아 둔 서명 주소로 카톡 그림 서버(kakaocdn)에서 그림을 GET으로 받는다 — 메시지 서버가 아니라 그림 파일 주소다.
> 대화에는 상대방의 개인정보(이름·메시지·사진)가 들어 있다. 필요한 만큼만 읽고, 밖으로 옮기거나 공개할 때 주의한다.

macOS 카카오톡 데스크톱의 로컬 DB를 [kakaocli](https://github.com/silver-flight-group/kakaocli)로 읽고, 키보드·마우스 없이 손쉬운 사용(접근성)으로 채팅 창을 열고 글·사진·이모티콘·답장·멘션을 보내는 에이전트 스킬이다. 카톡을 앞으로 띄우지 않아, 보던 창은 맨 위 그대로다. 본문은 [`SKILL.md`](SKILL.md).

이 스킬을 어떻게 만들었고, 내 AI 에이전트 도리가 자기 카톡 계정으로 지내며 무엇에 막히고 어떻게 고쳤는지는 블로그 글 [「도리가 카톡을 쓰면서 배운 것」](https://yongjjang.tygb99.com/blog/kakaocli-agent/)에 적었다.

- user ID 자동탐지 실패 우회(브루트포스 복구)와 키 직접 유도
- 발신자 이름 조인, KST 변환, 사진 원본 받기
- 열쇠·DB 경로를 env에 두고 `--db`로 넘겨 조회를 0.1초대로
- 큰 ID 정밀도, 보내는 중인 임시 줄, 수정 기록 같은 조회 함정
- 채팅 창으로 글·사진·파일을 보내고 DB로 전송 확인(기본은 미리보기, 실제 전송은 `--send`, `--dry-run` 지원). 사진·파일은 「파일전송」 단추로 뒤에서(클립보드 안 씀), 사진 여러 장을 「사진 N장」 묶음 하나로 보내려면 `--paste`(카톡이 몇 초 앞으로 온다)
- 카카오 이모티콘 보내기(`--emoticon`) — 이모티콘 창의 탭·칸은 접근성으로 누를 수 없어 그 누르기만 Aside Computer Use에 맡긴다(Aside 앱·CLI 필요)
- 닫힌 채팅 창 열기(본창 목록에서 그 방 줄을 선택하고 Return — 목록을 다 읽지 않고 DB 순서로 짐작한 줄 근처만 읽어, 655줄 목록에서 보내기까지 약 80초 → 약 6초. 카톡 설정 「오픈채팅 목록 분리」가 켜져 있으면 목록을 그 방 쪽(채팅/오픈채팅)으로 바꿔 찾고 되돌리기, 꺼져 있으면 한 목록에서 바로, 같은 이름 줄은 배지·미리보기로 고르기)
- 특정 글에 답장(오픈채팅은 「댓글」)하고 DB로 답장 연결 확인. 답장을 못 붙이면 입력칸을 비운 뒤 보통 글로 보내는 `--reply-fallback`
- 보낸 뒤 DB 글을 파일과 글자 대조(`CONTENT SAME`), 창 이름이 다른 방이면 `WRONG_ROOM`으로 알림, 실패해도 입력칸에 글을 남기지 않음
- 붙여 넣은 「@이름」이 아닌 진짜 멘션 칩 만들기
- 복제한 카톡 앱 등 다른 대상 앱(`--bundle-id`·`--pid`)
- 오픈채팅 스레드 답장(`scope=3`, `threadId`) 판정

## 설치

필요한 것: macOS, 카카오톡 데스크톱(로그인 상태), [kakaocli](https://github.com/silver-flight-group/kakaocli)(`brew install silver-flight-group/tap/kakaocli`), python3 3.9 이상(macOS 기본 `/usr/bin/python3`도 된다). 권한은 SKILL.md §1.

```bash
git clone https://github.com/Tygb99/kakaocli-skill.git ~/skills/kakaocli-skill
ln -s ~/skills/kakaocli-skill ~/.claude/skills/kakaocli-skill     # Claude Code. 다른 에이전트는 그 에이전트의 스킬 폴더(예: ~/.agents/skills/)
```

- 에이전트를 새로 시작해야 스킬 목록에 나타난다. 「카톡 검색해줘」처럼 말했을 때 `kakaocli-skill`을 읽으면 설치된 것이다.
- SKILL.md의 `scripts/...` 명령은 이 폴더(`~/skills/kakaocli-skill`)에서 실행한다.
- 예전 이름 `kakaocli-auth`로 설치했다면: 폴더를 `kakaocli-skill`로 옮기고, 스킬 폴더의 `kakaocli-auth` 링크를 지운 뒤 위 `ln -s`로 다시 건다. 스크립트에 옛 경로(`.../kakaocli-auth/scripts`)를 적어 둔 곳도 바꾼다.
- 지우기: 심볼릭 링크와 클론 폴더를 지우고, §7에서 만든 env 파일(열쇠가 들어 있다)도 지운다.

## scripts/

| 파일 | 하는 일 |
|---|---|
| `pick-account-hash.sh` | plist에서 활성 계정 해시 하나 고르기 |
| `recover-uid.py` | 계정 해시로 user ID 복구(멀티코어) |
| `derive-key.py` | Device UUID + user ID → DB 열쇠 |
| `kakao_db.py` | env의 열쇠·DB 경로로 빠른 질의 (모듈·명령 겸용) |
| `kakao-send.py` + `kakao-send-ui.js` | 채팅 창으로 글·사진·파일·이모티콘을 보내고 DB로 확인 |
| `kakao-attach-ui.js` | 사진·파일 하나를 「파일전송」 단추로 뒤에서 보내기(`--photo`·`--attach` 기본 길) |
| `kakao-clip-ui.js` | 사진·파일을 클립보드로 붙여 보내기(`--paste`, 사진 여러 장 묶음용) |
| `kakao-emoticon-ui.js` + `aside_cu.py` | 이모티콘 창 열기·칸 번호 읽기·전송·닫기(접근성)와 탭·칸 누르기(Aside Computer Use) — `--emoticon` |
| `kakao-open-ui.js` | 본창 채팅 목록에서 닫힌 채팅 창 열기(`kakao-send.py --open`·`--open-only`) |
| `kakao-reply-ui.js` | 글 하나에 답장·댓글(`kakao-send.py --reply-to`) |
| `kakao-mention-ui.js` | 진짜 멘션 칩(`kakao-send.py --mention`) |
| `extract-photos.py` | 사진 메시지의 원본 URL로 받아 방·발신자·시각 붙이기 |

## 출처

- `derive-key.py`는 kakaocli의 `Sources/KakaoCore/Database/KeyDerivation.swift`를 파이썬으로 옮긴 것이다(MIT, Copyright (c) 2026 Silver Flight Group, LLC). 원 구현은 [blluv의 gist](https://gist.github.com/blluv/8418e3ef4f4aa86004657ea524f2de14)를 기반으로 한다.
- `recover-uid.py`는 kakaocli `DeviceInfo.swift`의 user ID 복구 방식(Strategy 3)을 멀티코어로 다시 짠 것이다.
- kakaocli 라이선스 전문은 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

이 기기에서만 쓰는 값(user ID, 방 목록 등)은 `LOCAL.md`에 둔다. `.gitignore`로 저장소에서 빠진다. 열쇠는 env 파일(권한 600)에만 두고 저장소에 넣지 않는다.

## 라이선스

[MIT](LICENSE). 단 `scripts/derive-key.py`·`scripts/recover-uid.py`가 기대는 kakaocli 쪽 코드는 kakaocli의 MIT 고지를 따른다([`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)).
