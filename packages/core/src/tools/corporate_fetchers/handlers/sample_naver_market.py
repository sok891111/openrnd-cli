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
  - HTTP:    requests / httpx 등 자유롭게 사용 (pip 로 설치되어 있어야 함)

API 키(자격증명):
  - SYSTEM["id"] 로 시스템을 식별합니다(아래). 사용자가 프롬프트로
    "이 시스템 키는 이거야 등록해줘" 하면 manage_credential 툴이 저장하고,
    실행 시 환경변수 OPENRND_CRED_<ID> 로 주입됩니다.
  - 이 핸들러는 그 환경변수를 읽기만 하면 됩니다:
        import os
        token = os.environ.get("OPENRND_CRED_NAVER_MARKET")
"""

import os
import sys
from urllib.parse import urlparse

# 시스템 메타데이터(선택). manage_credential 의 'list' 가 이 정보로 사용자에게
# "어떤 시스템에 어떤 키가 필요한지" 안내합니다. id 는 자격증명 키이자
# 환경변수(OPENRND_CRED_<ID>)의 기준이 됩니다.
SYSTEM = {
    "id": "naver_market",
    "name": "네이버 증권 (샘플)",
    "description": "샘플 핸들러. 실제로는 사내 시스템 설명을 적으세요 "
    "(예: '사내 Jira REST API. Personal Access Token 필요').",
}


def can_handle(url: str) -> bool:
    return urlparse(url).hostname == "market.naver.com"


def fetch(url: str) -> str:
    # 샘플은 로깅만 하고 본문을 가져오지 않습니다(빈 문자열 → 브라우저 폴백).
    print(f"[sample] 요청 URL: {url}", file=sys.stderr)

    # API 키가 필요한 사내 시스템이라면 주입된 환경변수를 읽습니다(샘플은 불필요):
    token = os.environ.get("OPENRND_CRED_NAVER_MARKET")
    if token:
        print("[sample] 등록된 키 사용 가능", file=sys.stderr)

    # ── 실제 구현 예시 (주석 해제 후 사용) ──────────────────────────────
    # import requests
    # res = requests.get(url, timeout=15,
    #                    headers={"Authorization": f"Bearer {token}"})
    # res.raise_for_status()
    # return res.text        # ← 비어있지 않으면 "성공", 브라우저 폴백을 건너뜀
    # ────────────────────────────────────────────────────────────────────

    return ""
