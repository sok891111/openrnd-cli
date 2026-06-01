#!/usr/bin/env python3
"""iflow 사내 웹사이트 크롤러.

사내망에서만 접근 가능한 iflow 사이트를 크롤링하는 기본 스크립트입니다.
사용자가 파싱 규칙/인증/대상 셀렉터 등을 자유롭게 수정해서 사용합니다.

사용법:
    python script.py [URL]

URL 을 생략하면 DEFAULT_URL 을 사용합니다.
결과는 JSON 으로 표준출력에 출력됩니다.
"""

import json
import sys

# 크롤링 기본 대상. 실제 사내 iflow URL 로 교체하세요.
DEFAULT_URL = "http://iflow.internal/"

# 사내망 요청 시 사용할 헤더/타임아웃 등 기본 설정.
DEFAULT_TIMEOUT = 10  # seconds
DEFAULT_HEADERS = {
    "User-Agent": "openrnd-iflow-crawler/1.0",
}


def fetch(url: str) -> str:
    """주어진 URL 의 HTML 을 가져온다."""
    import requests

    resp = requests.get(
        url,
        headers=DEFAULT_HEADERS,
        timeout=DEFAULT_TIMEOUT,
        # 사내 자체 서명 인증서를 쓰는 경우 verify=False 로 변경할 수 있습니다.
        verify=True,
    )
    resp.raise_for_status()
    # 인코딩이 깨지면 resp.encoding 을 명시적으로 지정하세요. (예: "utf-8")
    return resp.text


def parse(html: str, url: str) -> dict:
    """HTML 을 파싱하여 필요한 데이터를 추출한다.

    여기서는 기본적으로 제목과 모든 링크를 추출합니다.
    실제 iflow 구조에 맞게 셀렉터를 수정해서 사용하세요.
    """
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")

    title = soup.title.get_text(strip=True) if soup.title else None

    links = []
    for a in soup.find_all("a", href=True):
        links.append(
            {
                "text": a.get_text(strip=True),
                "href": a["href"],
            }
        )

    # 본문 텍스트(공백 정리)
    text = soup.get_text(separator="\n", strip=True)

    return {
        "url": url,
        "title": title,
        "links": links,
        "text": text,
    }


def crawl(url: str) -> dict:
    html = fetch(url)
    return parse(html, url)


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL

    try:
        result = crawl(url)
    except ImportError as e:
        # requests / beautifulsoup4 미설치
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"필수 패키지가 없습니다: {e}. "
                    "`pip install requests beautifulsoup4` 로 설치하세요.",
                },
                ensure_ascii=False,
            )
        )
        return 1
    except Exception as e:  # noqa: BLE001 - 사용자에게 원인 그대로 전달
        print(
            json.dumps(
                {
                    "ok": False,
                    "url": url,
                    "error": f"{type(e).__name__}: {e}",
                    "hint": "사내망(VPN) 연결 또는 인증 설정을 확인하세요.",
                },
                ensure_ascii=False,
            )
        )
        return 1

    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
