#!/usr/bin/env python3
"""
corporate_fetchers 디스패처 — TS 브리지(corporate-fetch.ts)가 실행합니다.

흐름:
  1) stdin 으로 URL 한 줄을 받음
  2) handlers/ 안의 모든 핸들러 모듈을 로드
  3) can_handle(url) == True 인 첫 핸들러의 fetch(url) 결과(본문)를 stdout 으로 출력
  4) 매칭 핸들러가 없거나 빈 본문이면 아무것도 출력하지 않음 → 브라우저 폴백

규약:
  - **stdout = 본문 전용.** 본문 외의 것을 stdout 으로 출력하지 마세요.
  - **로그는 stderr 로.** stderr 한 줄은 openrnd 대화 터미널에 그대로 표시됩니다.

이 파일은 거의 손댈 일이 없습니다. 핸들러는 handlers/ 에 추가하세요.
"""

import importlib
import pkgutil
import sys
import traceback
from pathlib import Path

HANDLERS_DIR = Path(__file__).parent / "handlers"


def _log(msg: str) -> None:
    print(f"[corporate_fetch] {msg}", file=sys.stderr, flush=True)


def _load_handlers():
    """handlers/ 의 (밑줄로 시작하지 않는) 모든 모듈을 로드한다."""
    # handlers 패키지를 import 할 수 있도록 부모 디렉터리를 path 에 추가.
    parent = str(HANDLERS_DIR.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)

    loaded = []
    for info in pkgutil.iter_modules([str(HANDLERS_DIR)]):
        name = info.name
        if name.startswith("_"):
            continue
        try:
            mod = importlib.import_module(f"handlers.{name}")
        except Exception:
            _log(f"핸들러 import 실패: {name}\n{traceback.format_exc()}")
            continue
        if hasattr(mod, "can_handle") and hasattr(mod, "fetch"):
            loaded.append((name, mod))
        else:
            _log(f"핸들러 규약 누락(can_handle/fetch 정의 필요): {name}")
    return loaded


def main() -> int:
    url = sys.stdin.read().strip()
    if not url:
        return 0

    for name, mod in _load_handlers():
        try:
            if not mod.can_handle(url):
                continue
        except Exception:
            _log(f"{name}.can_handle 예외\n{traceback.format_exc()}")
            continue

        _log(f"핸들러 매칭: {name} -> {url}")
        try:
            content = mod.fetch(url)
        except Exception:
            _log(f"{name}.fetch 실패\n{traceback.format_exc()}")
            continue

        if content and content.strip():
            sys.stdout.write(content)
            sys.stdout.flush()
            _log(f"{name} 성공: {len(content)}자")
            return 0
        _log(f"{name} 빈 본문 → 다음 핸들러")

    _log("매칭 핸들러 없음 → 브라우저 폴백")
    return 0


if __name__ == "__main__":
    sys.exit(main())
