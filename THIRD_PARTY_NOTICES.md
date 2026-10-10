# 제3자 고지

## kakaocli

`scripts/derive-key.py`는 kakaocli의 `Sources/KakaoCore/Database/KeyDerivation.swift`를 옮긴 것이다.
`scripts/recover-uid.py`는 같은 저장소 `DeviceInfo.swift`의 user ID 복구 방식을 다시 짠 것이다.

출처: https://github.com/silver-flight-group/kakaocli

```
MIT License

Copyright (c) 2026 Silver Flight Group, LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

kakaocli의 키 유도 코드는 다시 blluv의 gist(https://gist.github.com/blluv/8418e3ef4f4aa86004657ea524f2de14)를 기반으로 한다. 이 gist에는 라이선스 표기가 없다.
