"""카카오톡 SQLCipher 키 유도 — kakaocli 의 KeyDerivation.secureKey 포팅.

kakaocli 의 chats/search/messages 는 --user-id 를 받지 않아 자동탐지를 다시 돌리고
또 실패한다. auth --verbose 가 찍어주는 Secure key 는 잘려 있어 쓸 수 없다.
그래서 키를 여기서 계산해 --key 로 넘긴다.

원 구현: Sources/KakaoCore/Database/KeyDerivation.swift
(https://gist.github.com/blluv/8418e3ef4f4aa86004657ea524f2de14 기반)

사용법:
    KEY=$(python3 derive-key.py "<DEVICE_UUID>" <USER_ID>)
    kakaocli search "검색어" --key "$KEY"

DEVICE_UUID 는 `kakaocli status` 의 Device UUID.
출력은 키 한 줄뿐이다 — 로그나 화면에 남기지 말 것.
"""
import base64
import hashlib
import sys


def secure_key(uuid: str, user_id: int) -> str:
    data = uuid.encode()
    # SHA-1 + SHA-256 을 이어붙여 base64
    hashed = base64.b64encode(
        hashlib.sha1(data).digest() + hashlib.sha256(data).digest()
    ).decode()

    parts = ["A", hashed, "|", "F", uuid[:5], "H", str(user_id), "|", uuid[7:]]
    password = "F".join(parts)[::-1]          # 뒤집어서 password 로 쓴다
    salt = uuid[int(len(uuid) * 0.3):]        # Swift 의 Int() 는 절삭이라 36자면 10부터

    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt.encode(), 100_000, dklen=128
    ).hex()


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    print(secure_key(sys.argv[1].strip(), int(sys.argv[2])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
