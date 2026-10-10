#!/bin/bash
# 활성 계정 해시 선택. 사용: pick-account-hash.sh [plist경로]  (경로 없으면 stdin에서 해시를 줄 단위로 읽음)
# sha512("0") = 빈 계정 해시를 제외하고 정확히 1개가 남으면 그것을 출력하고 exit 0, 0개/2개 이상이면 exit 2.
EMPTY=31bca02094eb78126a517b206a88c73cfa9ec6f704c7030d18212cace820f025f00bf0ea68dbf3f3a5436ca63b53bf7bf80ad8d5de7d8359d0b7fed9dbc3ab99
if [ -n "$1" ]; then
  HASHES=$(plutil -p "$1" | grep -o 'DESIGNATEDFRIENDSREVISION:[0-9a-f]*' | sed 's/DESIGNATEDFRIENDSREVISION://')
else
  HASHES=$(grep -oE '[0-9a-f]{128}')
fi
LEFT=$(printf '%s\n' $HASHES | grep -v '^$' | grep -vx "$EMPTY" | sort -u)
N=$(printf '%s\n' $LEFT | grep -c .)
if [ "$N" -eq 1 ]; then echo "$LEFT"; exit 0; fi
echo "candidates after removing sha512(\"0\"): $N" >&2; printf '%s\n' $LEFT >&2; exit 2
