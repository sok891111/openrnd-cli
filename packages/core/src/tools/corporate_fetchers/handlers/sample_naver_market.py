"""
[샘플 핸들러] market.naver.com

새 핸들러를 만들 때 이 파일을 복사해서 시작하세요.
  - 파일명은 도메인/시스템 단위로 (예: wiki_corp.py, jira_corp.py).
  - 한 파일 = 한 핸들러. 여러 명이 각자 파일만 추가하면 머지 충돌이 없습니다.

규약 (반드시 두 함수를 정의):
  - can_handle(url: str) -> bool : 이 핸들러가 처리할 URL인지 판단
  - fetch(url: str) -> str       : 본문 텍스트 반환
                                   ("" 빈 문자열이면 다음 핸들러/브라우저로)

팁:
  - 로그:    print("메시지", file=sys.stderr)   # 터미널에 바로 표시됨
  - 시크릿:  os.environ["MY_TOKEN"]              # 토큰은 환경변수로
  - HTTP:    requests / httpx 등 자유롭게 사용 (pip 로 설치되어 있어야 함)
"""

import sys
from urllib.parse import urlparse


def can_handle(url: str) -> bool:
    return urlparse(url).hostname == "market.naver.com"


def fetch(url: str) -> str:
    # 샘플은 로깅만 하고 본문을 가져오지 않습니다(빈 문자열 → 브라우저 폴백).
    print(f"[sample] 요청 URL: {url}", file=sys.stderr)

    # ── 실제 구현 예시 (주석 해제 후 사용) ──────────────────────────────
    # import requests
    # res = requests.get(url, timeout=15)
    # res.raise_for_status()
    # return res.text        # ← 비어있지 않으면 "성공", 브라우저 폴백을 건너뜀
    # ────────────────────────────────────────────────────────────────────

    return ""
