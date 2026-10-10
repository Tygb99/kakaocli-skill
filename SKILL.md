---
name: kakaocli-auth
description: "macOS kakaocli로 카카오톡 로컬 DB를 열어 대화를 검색·조회할 때 쓰는 인증과 조회 절차. '카톡 검색해줘', '톡방에서 찾아봐', '오픈채팅에서 ~ 관련 내용 찾아줘', '카카오톡 대화 읽어줘', '누가 그 말 했어?', '보낸 사람 이름도 보여줘', 'kakaocli 인증이 안 돼', 'auth 실패', 'User ID auto-detection failed', 'PRAGMA key failed' 같은 상황이면 이 스킬을 쓸 것. user ID 자동탐지는 사실상 항상 실패하므로 브루트포스로 뚫고 키를 직접 유도해야 하며, 발신자 이름은 NTUser 조인으로 붙인다 — 이 두 가지를 모르면 시작조차 못 하거나 전부 Unknown으로만 보인다. 조회가 느릴 때('카톡 조회가 느려', 'query가 오래 걸려')는 열쇠·DB 경로를 env에 두고 --db를 넘기는 절차를, '카톡 보내줘', '열린 채팅 창에 글 넣어줘'처럼 이미 열린 채팅 창으로 보낼 때는 kakao-send.py(dry-run·DB 확인)를, 오픈채팅 답장이 어느 글에 달린 말인지 판정할 때는 threadId(scope 3)를 다룬다. 채팅 창 열기 같은 일반 UI 자동화는 다루지 않는다."
---

# kakaocli 인증

kakaocli는 카카오톡의 암호화된 로컬 SQLite(SQLCipher)를 읽는다. 키는 **기기 UUID + 카카오 user ID**에서 유도되는데, **user ID 자동탐지가 깨져 있다.** 그걸 우회하는 게 이 문서의 전부다.

전제: macOS, 카카오톡 데스크톱 설치·로그인 상태. 읽기 명령은 카카오톡 창이 떠 있지 않아도 된다.

---

## 1. 설치와 권한

```bash
brew install silver-flight-group/tap/kakaocli
```

sqlcipher를 함께 깔고 소스에서 빌드한다.

**시스템 설정 > 개인정보 보호 및 보안**에서 터미널 앱에 권한을 준다:

- **전체 디스크 접근** — 모든 명령에 필요
- **손쉬운 사용** — `send`, `inspect`, 보내기 스크립트(§8)에만 필요

권한 부여는 사용자가 직접 해야 한다. 에이전트가 대신 켤 수 없다.

---

## 2. `kakaocli auth`는 실패한다 — 정상이다

```
User ID: auto-detection failed
  Candidates from AlertKakaoIDsList: 25411718, 344940307, 388584983, 366369712
No candidate user ID produced a valid key.
```

**후보 4개는 누구 기기에서나 똑같이 나온다.** 시스템/알림 발신자 ID라서 그렇다. 하나씩 `--user-id`로 넣어봐야 전부 실패한다.

업스트림 이슈: [#14](https://github.com/silver-flight-group/kakaocli/issues/14) (증상 전반), [#4](https://github.com/silver-flight-group/kakaocli/issues/4) (브루트포스 타임아웃이 짧다 — 근본 원인), [#16](https://github.com/silver-flight-group/kakaocli/issues/16) (20억까지 뒤져도 못 찾은 사례, closed)

`status`가 `App installed: No`라고 해도 무시한다. 한국어 환경은 앱 이름이 `/Applications/카카오톡.app`인데 코드가 `KakaoTalk.app` 경로를 하드코딩해서 그렇다. 나머지는 전부 번들 ID(`com.kakao.KakaoTalkMac`)로 찾으므로 조회에는 영향이 없다. 영향받는 건 이 표시 한 줄과, 카카오톡이 꺼져 있을 때 `send`가 자동 실행해주는 `launch()`뿐이다. 올려둔 이슈: [#22](https://github.com/silver-flight-group/kakaocli/issues/22)

**앱 이름을 바꾸지 말 것.** 앱 업데이트가 원래 이름으로 재설치해 두 벌이 남는다. 자동 실행이 꼭 필요하면 심볼릭 링크로 우회한다: `sudo ln -s /Applications/카카오톡.app /Applications/KakaoTalk.app`

---

## 3. user ID 복구 — 브루트포스

`DeviceInfo.swift`의 Strategy 3은 plist에 있는 `DESIGNATEDFRIENDSREVISION:<sha512hex>` 키에서 `sha512(str(userId))`의 원본을 0~10억 범위로 되찾으려 한다. 로직은 맞는데 **싱글스레드 + 10초 타임아웃**이라 도달 전에 포기한다.

멀티코어로 다시 돌리면 몇 초면 끝난다.

### 3-1. 해시 꺼내기

```bash
ls ~/Library/Containers/com.kakao.KakaoTalkMac/Data/Library/Preferences/
# com.kakao.KakaoTalkMac.<대문자 HEX>.plist 를 찾는다

plutil -p "<위 plist 경로>" | grep -o 'DESIGNATEDFRIENDSREVISION:[0-9a-f]*'
```

보통 두 개가 나온다. 하나는 `sha512("0")`(빈 계정)이라 버린다 — 눈으로 대조하지 말고 `scripts/pick-account-hash.sh "<plist 경로>"`를 쓴다: 빈 계정을 제외해 정확히 1개가 남으면 그 해시를 출력하고 exit 0, 0개나 2개 이상이면 exit 2다. `kakaocli status`의 `Account hash:` 앞부분과 같아야 한다.

### 3-2. 원본 찾기

```bash
python3 scripts/recover-uid.py <sha512hex>
```

못 찾으면 범위를 늘린다(두 번째 인자, 기본 20억).

---

## 4. 키는 직접 유도한다

user ID를 알아도 끝이 아니다:

- `auth --user-id <ID>`는 되지만, **`chats` / `search` / `messages`는 `--user-id`를 안 받는다.** 자동탐지를 다시 돌려서 또 실패한다.
- `auth --verbose`의 `Secure key:`는 **`...`로 잘려서 출력된다.** 복사해 써도 `PRAGMA key failed`가 난다.

그래서 키를 직접 계산해 `--key`로 넘긴다. `KeyDerivation.swift`를 그대로 포팅한 스크립트가 있다.

```bash
UUID=$(kakaocli status | awk -F': *' '/Device UUID/{print $2}')
KEY=$(python3 scripts/derive-key.py "$UUID" <USER_ID>)

kakaocli chats   --key "$KEY" --limit 50
kakaocli search  "검색어" --key "$KEY" --limit 50 --json
kakaocli messages --chat-id <ID> --key "$KEY" --limit 3000 --json
```

**키와 토큰은 절대 출력하지 않는다.** 변수로만 넘긴다.

키는 난수가 아니라 **UUID + user ID에서 결정적으로 유도된다 — 매번 같은 값이고, 무효화 수단은 사실상 카카오톡 재설치(UUID 변경)뿐이다.** "일회용이니 찍혀도 된다"는 성립하지 않는다.

**`--key`를 안 받는 명령에 넘기지 마라 — usage 에러가 `error: unrecognized arguments: --key <키 전문>`처럼 키 전문을 그대로 출력한다.** 스크립트마다 인자가 다르다: `derive-key.py`는 위치 인자, `extract-photos.py`는 `--user-id`, kakaocli 하위명령은 `--key`. 확신 없으면 `-h`부터.

키가 화면에 찍혔으면 세션 로그도 오염된 것이다. 해당 에이전트의 세션 로그(`~/.claude/projects/<프로젝트>/<세션ID>.jsonl`, `~/.codex/sessions/...`, `~/.omo/agent/sessions/...`)에서 키 hex를 `sed -i '' -E 's/<키 앞 12자>[0-9a-f]+/[REDACTED-KEY]/g'`로 치환하고, 키 **중간 구간** 문자열로 재검색해 0건을 확인한다(앞자리만 검색하면 방금 친 명령어의 패턴 조각에 걸린다).

---

## 5. 조회할 때 알아둘 것

### 시각은 UTC다

JSON의 `timestamp`는 `YYYY-MM-DDTHH:MM:SSZ` 형식이다. **`Z`를 무시하고 그대로 읽으면 9시간 어긋난다.** KST로 바꿔서 보고한다.

```python
kst = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ") + timedelta(hours=9)
```

텍스트 출력(`--json` 없이)은 로컬 시각으로 보여주므로 둘을 섞어 쓰면 헷갈린다. **하나로 통일한다.**

### 보낸 사람 이름은 SQL로 붙인다

`messages` / `search`가 발신자를 `Unknown`으로 보여주는 건 조인을 안 해서일 뿐, **이름은 이미 DB에 있다.** `NTUser`에 오픈채팅 참여자까지 들어 있고 `NTChatMessage.authorId`로 그대로 걸린다.

```sql
SELECT datetime(m.sentAt,'unixepoch','+9 hours') AS kst,
       COALESCE(NULLIF(u.nickName,''), NULLIF(u.displayName,''),
                NULLIF(u.friendNickName,''), '(?)')            AS name,
       m.message
FROM NTChatMessage m
LEFT JOIN NTUser u ON u.userId = m.authorId
WHERE m.chatId = <CHAT_ID>
ORDER BY m.sentAt
```

`kakaocli query "<SQL>" --key "$KEY"` 로 돌린다. 결과는 값만 담긴 **2차원 배열 JSON**이라 컬럼명이 없다 — 순서로 받는다.

- `sentAt`은 unix epoch. `'+9 hours'`로 SQL 안에서 KST 변환이 끝난다(§ 시각 항목의 UTC 함정을 피할 수 있다).
- 오픈채팅 참여자는 방마다 닉네임이 다를 수 있다. `nickName`이 그 방 표시명이고, `displayName`/`friendNickName`은 내 주소록 기준이다. 위 `COALESCE` 순서가 실제 대화 표시에 가장 가깝다.
- 같은 사람이 여러 행으로 잡히기도 한다(`PRIMARY KEY (userId, linkId)`, `linkId`는 오픈링크별).

주요 테이블: `NTChatMessage`(chatId, logId, authorId, message, sentAt, attachment…), `NTUser`, `NTChatRoom`, `NTOpenLink`.

### 방 이름

`chats`가 방 이름을 `(unknown)`으로 보여줘도 DB로 충분하다. 오픈채팅 방 이름은 `NTOpenLink.linkName`에 있다(§6 「방 목록을 다시 뽑을 때」 SQL). 방을 특정할 땐 이름 대신 `chat_id`를 쓰고, `search`는 방 이름 없이 전 대화를 뒤진다.

### 조인은 메시지를 복제한다 — `logId`로 묶어라

`NTUser`의 기본키는 `(userId, linkId)`다. **오픈링크마다 행이 따로 생긴다.**
그래서 위 `LEFT JOIN`을 그대로 쓰면 **한 사람이 가진 행 수만큼 같은 메시지가 복제된다.**

```sql
SELECT datetime(m.sentAt,'unixepoch','+9 hours'),
       (SELECT COALESCE(NULLIF(u.nickName,''), NULLIF(u.displayName,''), '(?)')
          FROM NTUser u WHERE u.userId = m.authorId LIMIT 1) AS name,
       COALESCE(m.message,'')
FROM NTChatMessage m
WHERE m.chatId = <CHAT_ID> AND m.sentAt >= strftime('%s','<YYYY-MM-DD HH:MM:SS>')
GROUP BY m.logId          -- ← 이것 없이는 건수가 부풀려진다
ORDER BY m.sentAt
```

**조인 결과가 이상하면 발신자 수부터 세라.** `GROUP BY m.authorId`로 세면
같은 사람의 여러 닉네임이 한 `authorId`로 모여 바로 드러난다.

### 사진은 NTChatMessage에서 원본으로 되받는다

사진을 **로컬 파일 복호화로 꺼내려 하지 마라. 그건 막혀 있다.**
`NTChatMessage`의 **사진 메시지 `attachment`에 원본 풀해상도 서명 URL이 들어 있다.** 그걸 받는다.

막힌 경로:

- `fsCachedData/<UUID>` — 파일이 **암호화**돼 있다. JPEG/PNG/WebP 서명이 하나도 없다. 못 푼다.
- `Cache.db`의 CDN URL(`open.kakaocdn.net/dn`)로 받을 수는 있으나, **프로필 이미지가 같은 호스트를 써서** 사진과 프로필이 섞이고 방·발신자도 못 붙는다. **이 경로 쓰지 마라.**

되는 경로 — `NTChatMessage.attachment`는 **텍스트(type 1)만 `{}`이고, 사진 메시지엔 채워져 있다**:

- `type=2` (단일 사진) → `attachment.url` = 원본
- `type=27` (다중 사진) → `attachment.imageUrls[]` = 원본 여럿
- `type=3` (동영상) → `attachment.url`
- 각 행에 `chatId`·`authorId`·`sentAt`이 있어 **어느 방·누가·언제까지 정확히 붙는다.** 프로필과 안 섞인다.

```bash
# 방 전체 또는 KST 구간으로. 발신자 이름(NTUser 조인)·방ID·시각이 파일명/매니페스트에 붙는다.
python3 scripts/extract-photos.py --chat-id <CHAT_ID> --out kakao_photos
python3 scripts/extract-photos.py --since "<YYYY-MM-DD 00:00:00>" --until "<YYYY-MM-DD 23:59:59>"
# 먼저 목록·만료여부만: --list-only   /  동영상까지: --include-video
# ⚠️ 이 스크립트는 --key를 안 받는다. 키는 KAKAO_DB_KEY(§7)를 쓰고, 없으면 --user-id <USER_ID>(또는 KAKAO_USER_ID)로 내부에서 유도한다.
#    --key를 붙이면 usage 에러에 키 전문이 찍힌다(§4).
```

파일명 `{KST}_{발신자}_{logId}_{i}.jpg`, `manifest.csv`에 `kst,chatId,sender,logId,idx,http,file,url`을 기록한다.

**한계 — 서명 URL은 사진 전송 후 약 4일만 유효하다**(그 뒤 HTTP 410 Gone). 그보다 오래된 사진은 서명이 죽었고 로컬 캐시도 암호화라 **프로그램으로는 못 받는다**. 그때는 사용자 캡처로 넘긴다. 스크립트는 만료분을 410으로 표시하고 건너뛴다.

주의:
- **HEAD 요청은 이 CDN에서 거짓 404를 준다.** 반드시 GET(=`curl` 기본)으로 받는다.
- `authorId` → `NTUser` 조인은 §"조인은 메시지를 복제한다"의 `linkId` 함정과 무관하다(여기선 서브쿼리 `LIMIT 1`).
- 만료 여부는 `--list-only`로 먼저 본다(스크립트가 410을 표시한다).

### `messages`는 `text`가 없는 행을 섞어 준다

사진·입퇴장·시스템 메시지는 `text`가 `null`이다. `r.get('text') or ''`로 받는다. 안 그러면 `KeyError`로 죽는다.

`{"feedType":...}` 형태의 JSON 문자열이 그대로 본문에 들어있는 행도 있다. 시스템 이벤트다.

### 검색은 전 대화 대상이다

광고 메시지, 다른 방 대화까지 다 걸린다. 키워드 하나로 판단하지 말고 **날짜 분포를 먼저 세어** 관련 구간을 좁힌다.

### 오픈채팅 답장은 스레드로 저장된다 — `threadId`부터 본다

오픈채팅에서 메시지에 「답장」하면 스레드로 열린다. DB에는 `type 26` + `attachment.src_logId`가 아니라 **`scope=3`, `threadId=<원글 logId>`**로 저장된다(`supplement`에 `{"scope":3,"threadId":…}`). 일반 메시지는 `scope=1`, `threadId=0`이다. 봇 등 일부 발신자는 `type 26` 방식도 쓰므로 둘 다 본다.

**누가 누구에게 한 말인지 순서로 짐작하지 마라.** 바로 위 메시지가 아니라 한참 전 글의 스레드 답장일 수 있다. 원글은 `threadId`로 찾는다:

```sql
SELECT datetime(m.sentAt,'unixepoch','+9 hours'), m.authorId, COALESCE(m.message,''),
       m.threadId, r.authorId AS rootAuthor, substr(COALESCE(r.message,''),1,40) AS rootHead
FROM NTChatMessage m
LEFT JOIN NTChatMessage r ON r.chatId = m.chatId AND r.logId = m.threadId
WHERE m.chatId = <CHAT_ID> AND m.scope = 3
GROUP BY m.logId
ORDER BY m.sentAt
```

감시 스크립트가 "내 글에 달린 답"을 잡으려면 `threadId`의 원글 작성자(`rootAuthor`)가 나인지도 본다.

---

## 6. 이 기기의 값은 `LOCAL.md`에 둔다

복구한 user ID, 자주 보는 방의 chatId, 방 운영 메모처럼 **그 기기·그 사람에게만 해당하는 값은 이 스킬 폴더의 `LOCAL.md`에 적는다.** `.gitignore`에 들어 있어 저장소에는 올라가지 않는다. 있으면 조회 전에 먼저 읽는다.

`LOCAL.md`에 둘 만한 것:

```
User ID       : <recover-uid.py로 찾은 값>
env 파일      : <§7의 secrets.env 경로>
자주 쓰는 방  : | 방 | linkId | chatId |
운영 메모     : 방별 공개하지 않는 기준·승인 절차
```

user ID는 계정이 바뀌지 않는 한 그대로다. 카카오톡을 재설치하거나 기기를 옮기면 UUID가 바뀌므로 키를 다시 유도한다.

방 목록을 다시 뽑을 때(이름은 `NTOpenLink`에 있다):

```sql
SELECT o.linkId, o.linkName,
       (SELECT c.chatId FROM NTChatRoom c WHERE c.linkId = o.linkId LIMIT 1)
FROM NTOpenLink o
```

---

## 7. 빠른 조회 — 열쇠·DB 경로를 env에 두고 `--db`를 넘겨라

한 기기에서 잰 값: 열쇠를 매번 만들면 `kakaocli status`가 15~60초 걸린다(User ID 자동탐지가 후보 4개를 다 돌고 실패한다). `kakaocli query`에 `--db`를 안 주면 DB 파일을 찾느라 `SELECT 1`도 약 11초다. **열쇠와 DB 경로를 미리 적어 두고 `--db`를 주면 둘 다 0.1초 안팎이다.**

### 7-1. env 파일 만들기 (한 번)

위치는 정해져 있지 않다 — 사용자가 고른다. 예: `~/.config/<이름>/secrets.env`, 권한 600. DB 파일 이름은 `kakaocli status`의 `Database name:`이다.

```bash
ENVF=~/.config/<이름>/secrets.env
mkdir -p "$(dirname "$ENVF")"; touch "$ENVF"; chmod 600 "$ENVF"
cp "$ENVF" "$ENVF.bak-$(date +%Y%m%d)"                      # 바꾸기 전 백업
sed -i '' '/^KAKAO_DB_KEY=/d;/^KAKAO_DB_PATH=/d;/^KAKAO_USER_ID=/d' "$ENVF"   # 예전 줄 지우기

UID_=<USER_ID>
ST=$(kakaocli status)
UUID=$(printf '%s\n' "$ST" | awk -F': *' '/Device UUID/{print $2}')
DBNAME=$(printf '%s\n' "$ST" | awk -F': *' '/Database name/{print $2}')
DB="$HOME/Library/Containers/com.kakao.KakaoTalkMac/Data/Library/Application Support/com.kakao.KakaoTalkMac/$DBNAME"
KEY=$(python3 scripts/derive-key.py "$UUID" "$UID_")
[ -f "$DB" ] && printf 'KAKAO_DB_KEY=%s\nKAKAO_DB_PATH="%s"\nKAKAO_USER_ID=%s\n' "$KEY" "$DB" "$UID_" >> "$ENVF"
unset KEY
awk -F= '/^KAKAO_DB_KEY=/{print "key length", length($2)}' "$ENVF"   # 256이면 맞다. 파일을 cat 하지 않는다
```

### 7-2. 쓰기

스크립트(`kakao_db.py`, `kakao-send.py`, `extract-photos.py`)는 값마다 **환경변수 → `KAKAO_ENV_FILE`이 가리키는 파일** 순서로 `KAKAO_DB_KEY`·`KAKAO_DB_PATH`·`KAKAO_USER_ID`를 찾는다. 열쇠가 없으면 예전처럼 `kakaocli status`로 만든다(느리다).

```bash
export KAKAO_ENV_FILE=~/.config/<이름>/secrets.env
python3 scripts/kakao_db.py "SELECT count(*) FROM NTChatMessage"   # 결과 JSON, 걸린 시간은 stderr
```

파이썬에서: `sys.path.insert(0, "<스킬>/scripts"); from kakao_db import derive_key, q` → `q(derive_key(), sql)`.

kakaocli를 직접 부를 때도 `--db`를 준다(`query`·`chats`·`search`·`messages` 모두 받는다):

```bash
set -a; . "$KAKAO_ENV_FILE"; set +a
kakaocli query "<SQL>" --db "$KAKAO_DB_PATH" --key "$KAKAO_DB_KEY"
```

- env 파일에는 열쇠 전문이 있다. 저장소·로그·화면에 내지 않는다(§4와 같다).
- 카카오톡 재설치·기기 변경·계정 변경으로 열쇠가 바뀌면 질의가 실패한다 → 7-1을 다시 한다.
- `--db` 질의가 실패하면 `kakao_db.q`는 `--db` 없이 한 번 더 돈다(느리지만 동작한다).

---

## 8. 열린 채팅 창으로 보내기 — `scripts/kakao-send.py`

사용자의 마우스·키보드를 쓰지 않고(System Events 접근성만) **이미 열린** 채팅 창 입력칸에 글을 넣고 전송 버튼을 누른 뒤, DB에 내 메시지가 생겼는지로 성공을 판정한다.

```bash
export KAKAO_ENV_FILE=~/.config/<이름>/secrets.env
python3 scripts/kakao-send.py --window "<창 제목>" --chat-id <CHAT_ID> --file msg.txt --dry-run   # 넣었다 지우기만
python3 scripts/kakao-send.py --window "<창 제목>" --chat-id <CHAT_ID> --file msg.txt --me <USER_ID>
```

| 끝 줄 | 뜻 |
|---|---|
| `DRYRUN_OK` | 입력칸에 넣은 값이 파일과 같았고, 다시 비웠다. 보내지 않았다 |
| `SENT_OK <KST>` | DB에서 내 메시지를 찾았다 |
| `FAIL WINDOW_NOT_OPEN` | 그 제목의 창이 없다 — 이 스크립트는 창을 열지 않는다 |
| `FAIL BOX_NOT_EMPTY` | 입력칸에 이미 글이 있다. 덮지도 지우지도 않는다 |
| `FAIL VALUE_MISMATCH` | 넣은 값이 파일과 달라 입력칸을 비우고 멈췄다 |
| `FAIL NOT_IN_DB` | 버튼은 눌렀는데 15초 안에 DB에 안 보인다 |

- `kakao-send-ui.js`(JXA)는 창의 scrollArea 안 `textArea`(description `메시지 입력`)와 `button 전송`만 바로 짚는다(약 0.2초). **창 전체 접근성 트리를 훑지 마라** — 창 전체를 읽으면 25~30초, System Events로 목록 행을 훑으면 150초가 넘는다.
- 카카오톡은 `AXPress`에 오류를 돌려줘도 실제로 보낸다. 그래서 성공은 DB(내 `authorId`, 누른 시각 이후, 앞 40자 일치)로만 판단한다. `NOT_IN_DB`가 나오면 **다시 보내기 전에 DB로 그 방을 먼저 확인한다**(중복 전송 방지).
- 창 제목은 방 이름 그대로다. 창 여는 법(실측): 카톡 본창 「오픈채팅」 탭 → 목록에서 방을 더블클릭. 검색칸에 값만 넣으면(setValue) 결과가 안 뜬다. 카카오톡을 재시작하면 열린 채팅 창이 모두 닫힌다.
- 처음 쓰는 방·창이면 `--dry-run`부터. 실제 전송은 사용자가 시킨 글만 한다.
- 권한: 손쉬운 사용(osascript를 부르는 앱), 전체 디스크 접근(DB 확인).
- `메시지 입력`·`전송`은 한국어 UI에서 확인한 이름이다. 다른 언어 UI면 `kakao-send-ui.js`의 두 문자열을 바꾼다.
- JXA 메모: `app.read(path, {as:'utf8'})`는 null을 준다 → `$.NSString.stringWithContentsOfFileEncodingError`로 읽는다.

---

## 점검

- [ ] 전체 디스크 접근 권한을 줬는가
- [ ] 빈 계정 해시(`31bca020...`)를 골라내고 활성 해시를 썼는가
- [ ] `--key`로 넘겼는가 (`chats`/`search`/`messages`는 `--user-id`를 안 받는다)
- [ ] 키를 화면에 찍지 않았는가 — `--key`를 안 받는 스크립트(`extract-photos.py`)에 넘겨 usage 에러로 새지 않았는가. 샜다면 세션 .jsonl 치환까지 했는가(§4)
- [ ] 타임스탬프를 KST로 변환했는가 (`--json`은 UTC, `query`는 `'+9 hours'`)
- [ ] `text`가 `null`인 행을 방어했는가
- [ ] 발신자 이름이 필요하면 `NTUser` 조인을 썼는가
- [ ] **`GROUP BY m.logId`로 묶었는가** (안 묶으면 건수가 몇 배로 부풀려진다)
- [ ] 반복 조회라면 `KAKAO_DB_KEY`·`KAKAO_DB_PATH`를 env 파일(권한 600)에 두고 `--db`를 넘겼는가, 파일 내용을 화면에 찍지 않았는가(§7)
- [ ] 오픈채팅에서 누가 누구에게 답했는지 판정할 때 순서가 아니라 `scope=3`·`threadId`를 봤는가(§5)
- [ ] 보낼 때 창이 열려 있고 입력칸이 비었는가, 처음이면 `--dry-run`부터, 성공은 `SENT_OK`(DB 확인)로만 판단했는가(§8)
- [ ] 이 기기 값(user ID·chatId·방 이름)을 SKILL.md가 아니라 `LOCAL.md`에 적었는가(§6)
- [ ] 사진을 찾고 있다면 — 로컬/Cache.db 말고 `scripts/extract-photos.py`(NTChatMessage type=2·27)로 받았는가. 4일 지난 건 410이라 사용자 캡처로 넘겼는가(§5)
