"""카카오톡 user ID 복구 — sha512(str(id)) 를 계정 해시에 맞춰 되찾는다.

kakaocli 의 Strategy 3(DeviceInfo.swift)가 같은 일을 하지만 싱글스레드 + 10초
타임아웃이라 도달 전에 포기한다(업스트림 이슈 #14). 여기서는 코어 수만큼 나눠 돌린다.

사용법:
    python3 recover-uid.py <sha512hex> [탐색상한]

<sha512hex> 는 plist 의 DESIGNATEDFRIENDSREVISION:<hash> 에서 꺼낸다.
sha512("0") = 31bca020... 은 빈 계정이므로 그건 쓰지 않는다.
"""
import hashlib
import multiprocessing as mp
import sys
import time

EMPTY_ACCOUNT_HASH = (
    "31bca02094eb78126a517b206a88c73cfa9ec6f704c7030d18212cace820f025"
    "f00bf0ea68dbf3f3a5436ca63b53bf7bf80ad8d5de7d8359d0b7fed9dbc3ab99"
)

TARGET = b""


def _init(target_bytes):
    global TARGET
    TARGET = target_bytes


def scan(bounds):
    lo, hi = bounds
    sha512 = hashlib.sha512
    target = TARGET
    for i in range(lo, hi):
        if sha512(b"%d" % i).digest() == target:
            return i
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    target_hex = sys.argv[1].strip().lower()
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 2_000_000_000

    if len(target_hex) != 128:
        print(f"해시 길이가 128이 아닙니다: {len(target_hex)}")
        return 1
    if target_hex == EMPTY_ACCOUNT_HASH:
        print('이건 sha512("0") — 빈 계정 해시입니다. 다른 쪽 해시를 쓰세요.')
        return 1

    target = bytes.fromhex(target_hex)
    workers = mp.cpu_count()
    chunk = 2_000_000
    ranges = [(lo, min(lo + chunk, limit)) for lo in range(0, limit, chunk)]

    print(f"target : {target_hex[:24]}…")
    print(f"range  : 0 … {limit:,}")
    print(f"workers: {workers}")
    start = time.time()

    with mp.Pool(workers, initializer=_init, initargs=(target,)) as pool:
        for found in pool.imap_unordered(scan, ranges):
            if found is not None:
                pool.terminate()
                ok = hashlib.sha512(str(found).encode()).hexdigest() == target_hex
                print(f"\nFOUND user_id = {found}   ({time.time() - start:.1f}s)")
                print("verify :", "OK" if ok else "MISMATCH")
                return 0

    print(f"{limit:,} 까지 못 찾았습니다. 상한을 올려 다시 시도하세요.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
