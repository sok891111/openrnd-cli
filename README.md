# openrnd

업무용 AI CLI — OpenAI-compatible LLM에 연결하는 터미널 에이전트.

Google Gemini CLI를 기반으로, 파일 읽기·쓰기·편집·검색·셸 실행 등 코딩 도구는
그대로 유지하면서 크롤링·데이터 처리·자동화·MCP 연동·사내 시스템(웹 fetch,
Oracle DB) 연동 등 실무 작업에 특화한 CLI입니다.

---

## 주요 기능

| 기능                       | 설명                                                      |
| -------------------------- | --------------------------------------------------------- |
| **OpenAI-compatible 연결** | Ollama, LM Studio, OpenAI, vLLM 등 모든 호환 서비스 지원  |
| **Python 실행**            | 크롤링·데이터 처리 스크립트를 대화 중 직접 실행           |
| **MCP 서버 관리**          | 프롬프트 한 줄로 MCP 서버 추가/삭제                       |
| **Skill 관리**             | 프롬프트로 재사용 가능한 워크플로 Skill 생성/관리         |
| **파일 조작**              | 읽기·쓰기·편집, 검색, 디렉터리 탐색                       |
| **웹 검색 / 페이지 수집**  | 웹 검색, URL 수집(web fetch → 사내 fetch → 브라우저 폴백) |
| **Oracle DB 조회**         | TNS 접속 등록 후 **SELECT 전용** 조회(다층 가드레일)      |
| **셸 실행**                | 백그라운드 프로세스 포함 임의 명령 실행                   |

---

## 시스템 요구사항

- **Node.js** 20 이상
- **OS**: Windows 10/11, macOS, Linux
- OpenAI-compatible LLM 서비스 (로컬 또는 원격)

---

## 설치

### 1. 저장소 클론

```bash
git clone https://github.com/your-username/openrnd.git
cd openrnd
```

### 2. 의존성 설치 및 빌드

```bash
npm install
npm run build --workspace=@openrnd/core
npm run build --workspace=@openrnd/cli
node esbuild.config.js
node scripts/copy_bundle_assets.js
```

### 3. 전역 명령어 등록

```bash
npm link
```

설치 확인:

```bash
openrnd --version
# 0.1.0
```

---

## LLM 연결 설정

### 빠른 설정

```bash
openrnd llm set \
  --base-url "https://your-api.com/v1" \
  --model   "your-model-name" \
  --api-key "your-api-key"
```

설정은 `~/.openrnd/settings.json`에 저장됩니다. 이후 `openrnd`만 실행하면
자동으로 연결됩니다.

### 연결 확인

```bash
openrnd llm test   # ping 테스트
openrnd llm show   # 현재 설정 확인
```

### 서비스별 설정 예시

**Ollama (로컬)**

```bash
openrnd llm set \
  --base-url "http://localhost:11434/v1" \
  --model   "llama3.2" \
  --api-key "ollama"
```

**LM Studio (로컬)**

```bash
openrnd llm set \
  --base-url "http://localhost:1234/v1" \
  --model   "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF" \
  --api-key "lm-studio"
```

**OpenAI**

```bash
openrnd llm set \
  --base-url "https://api.openai.com/v1" \
  --model   "gpt-4o" \
  --api-key "sk-..."
```

**기타 OpenAI-compatible 서비스** (vLLM, llama.cpp server, Azure OpenAI 등)

```bash
openrnd llm set \
  --base-url "https://your-endpoint/v1" \
  --model   "model-name" \
  --api-key "api-key"
```

### 환경변수로 설정 (선택)

설정 파일 대신 환경변수를 사용할 수도 있습니다. 환경변수가 설정 파일보다
우선합니다.

```bash
export OPENRND_BASE_URL="https://your-api.com/v1"
export OPENRND_MODEL="your-model-name"
export OPENRND_API_KEY="your-api-key"
```

### 디버그 로깅 (연결 문제 진단)

응답이 오지 않거나 연결 오류가 의심될 때 `OPENRND_DEBUG=true`를 설정하면 상세
로그가 stderr와 `~/.openrnd/debug.log`에 동시 기록됩니다.

```bash
OPENRND_DEBUG=true \
OPENRND_BASE_URL="http://your-llm-server/v1" \
OPENRND_MODEL="your-model" \
OPENRND_TRUST_WORKSPACE=true \
openrnd
```

로그 확인:

```bash
# 실시간
tail -f ~/.openrnd/debug.log

# 전체 덤프
cat ~/.openrnd/debug.log
```

| 로그 항목           | 내용                             |
| ------------------- | -------------------------------- |
| `initialized`       | 접속 URL·모델 설정 확인          |
| `request`           | 요청 URL, 메시지 수/길이         |
| `response received` | HTTP 상태 코드·헤더              |
| `HTTP error`        | 서버 응답 에러 바디 전문         |
| `fetch failed`      | 네트워크/연결 에러 스택 트레이스 |
| `stream done`       | 수신된 총 청크 수                |

---

## 실행

### 대화형 모드

```bash
openrnd
```

### 단일 프롬프트 (헤드리스)

```bash
openrnd -p "이 디렉터리의 Python 파일 목록을 보여줘"
```

### 신뢰 워크스페이스 설정 (헤드리스 실행 시 필요)

```bash
OPENRND_TRUST_WORKSPACE=true openrnd -p "..."
# 또는
openrnd --skip-trust -p "..."
```

---

## 주요 도구 사용법

### Python 실행 (`run_python`)

대화 중 Python 코드를 직접 작성·실행합니다.

```
웹사이트 https://example.com 을 크롤링해서 제목과 링크를 CSV로 저장해줘
```

모델이 Python 코드를 작성하고 `run_python` 도구로 즉시 실행합니다.

### MCP 서버 관리 (`manage_mcp`)

프롬프트로 MCP 서버를 추가할 수 있습니다.

```
파일시스템 MCP 서버 추가해줘. /home/work 경로를 사용할거야
```

또는 CLI 직접 사용:

```bash
# stdio (로컬 명령 실행)
openrnd mcp add filesystem npx -- -y @modelcontextprotocol/server-filesystem /home/work

# HTTP/SSE
openrnd mcp add my-server https://my-mcp-server.com/sse --transport sse

# 목록 확인
openrnd mcp list
```

### Skill 관리 (`manage_skill`)

재사용 가능한 워크플로를 Skill로 저장합니다.

```
웹 크롤링 자동화 skill 만들어줘.
BeautifulSoup 기반으로 하고, robots.txt 준수하도록 해줘
```

또는 CLI 직접 사용:

```bash
# 설치 (git 저장소 또는 로컬 경로)
openrnd skills install https://github.com/user/my-skill
openrnd skills install ./my-skill.skill

# 목록 확인
openrnd skills list

# 대화 중 활성화
openrnd
> /skills reload   # 새 skill 반영
```

Skill 파일 위치: `~/.openrnd/skills/<name>/SKILL.md`

---

## Oracle DB 조회 (`manage_oracle_connection`, `oracle_query`)

사내 Oracle DB 의 데이터를 **SELECT 조회 전용**으로 직접 볼 수 있습니다.
사용자가 TNS 접속 정보를 등록하면 그 정보로 접속해 조회합니다.

> **읽기 전용 보장(가드레일).** 어떤 경우에도 SELECT 만 실행됩니다.
> INSERT/UPDATE/DELETE 같은 DML, DROP/TRUNCATE/ALTER/CREATE 같은 DDL, PL/SQL
> 블록, 다중 문장, `DBMS_*`/`UTL_*` 호출, `SELECT ... FOR UPDATE` 는 실행
> **전에** 거부됩니다. 추가로 접속 직후 `SET TRANSACTION READ ONLY` 로
> 트랜잭션을 읽기 전용으로 고정하고 절대 commit 하지 않으므로, DB 레벨에서도
> 쓰기가 차단됩니다(만약의 우회 시 Oracle 이 ORA-01456 에러).

### 1) 접속 등록 — 프롬프트로

```
오라클 prod 접속 등록해줘.
user=scott, password=tiger,
tns=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.corp)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL)))
  → manage_oracle_connection set(alias="prod", user="scott", password="tiger", connect_string="(DESCRIPTION=...)")
```

`connect_string` 에는 다음 중 무엇이든 넣을 수 있습니다:

- **tnsnames.ora 풀 디스크립터**:
  `(DESCRIPTION=(ADDRESS=...)(CONNECT_DATA=...))`
- **Easy Connect**: `db.corp:1521/ORCL`
- **net service name**: `MYDB` (환경변수 `TNS_ADMIN` 으로 tnsnames.ora 위치 지정
  시)

등록 정보는 `~/.openrnd/oracle-connections.json` (chmod 600, git 범위 밖)에
저장되며, 비밀번호는 화면에 마스킹되어 표시됩니다.

```
등록된 오라클 접속 목록 보여줘     → manage_oracle_connection list
오라클 prod 연결 테스트해줘        → manage_oracle_connection test(alias="prod")
오라클 dev 접속 삭제해줘           → manage_oracle_connection remove(alias="dev")
```

### 2) 조회

```
오라클 prod 에서 최근 주문 10건 보여줘
  → oracle_query(connection="prod", sql="SELECT * FROM orders ORDER BY created_at DESC", max_rows=10)
```

- `max_rows`: 최대 반환 행 수 (기본 100, 최대 1000).
- 결과는 표로 표시되고, 모델에는 구조화된 JSON 으로도 전달됩니다.

### 요구사항

- Oracle 드라이버 **`oracledb`** (optional dependency). Thin 모드로 동작하므로
  Oracle Instant Client 설치는 **불필요**합니다.
- 배포 tarball 등에서 누락된 경우 `npm install oracledb` 한 번이면 됩니다.
  (미설치 시 조회 툴이 친절한 안내 에러를 냅니다.)

---

## 웹 페이지 수집 (`web_fetch`) 과 사내 fetch 커스터마이징

URL 콘텐츠를 가져올 때 openrnd는 다음 **3단계 폴백 체인**으로 동작합니다. 앞
단계가 실패하거나 SSO/인증 벽에 막히면 다음 단계로 넘어갑니다.

```
1) web fetch            서버사이드 HTTP fetch (일반 공개 URL)
        │  (실패 / 인증벽 / SSO 스텁 감지)
        ▼
2) 사내 URL별 fetch     ★ Python 핸들러로 구현하는 영역 ★
        │  (매칭 핸들러 없음 / 모두 실패)
        ▼
3) 브라우저 세션 열기    로그인된 Chrome 세션으로 페이지를 직접 읽음
```

사내 인트라넷 URL은 보통 SSO 뒤에 있어 1)번 서버 fetch가 통하지 않습니다. 2)번
단계의 **사내 URL별 전용 fetch 방법**(REST API 토큰, 사내 프록시 경유 등)을
**Python 으로** 작성해 끼워 넣을 수 있습니다.

### 디렉터리 구조 (프로젝트 안에서 git 으로 관리)

```
packages/core/src/tools/corporate_fetchers/
├── dispatch.py                       # 디스패처 (거의 손댈 일 없음)
└── handlers/
    ├── __init__.py
    ├── sample_naver_market.py        # 샘플 핸들러
    └── <도메인>.py                   # ★ URL별 핸들러를 하나씩 추가 ★
```

- **한 파일 = 한 핸들러.** URL(도메인)별로 파일을 나눠 두면 여러 명이 각자
  파일만 추가/수정하므로 **머지 충돌이 나지 않습니다.**
- TS(`corporate-fetch.ts`)는 이 Python 을 실행하는 **얇은 브리지**일 뿐이라 손댈
  필요가 없습니다.

### 핸들러 추가하기

`handlers/` 에 새 `.py` 파일을 만들고 **두 함수만** 정의하면 됩니다.
(`handlers/sample_naver_market.py` 를 복사해서 시작하세요.)

```python
# handlers/jira_corp.py
import os
import sys
from urllib.parse import urlparse
import requests

# 시스템 메타데이터(선택). manage_credential 의 'list' 가 이 정보로 사용자에게
# "어떤 시스템에 키가 필요한지" 안내합니다. id 가 자격증명 키이자 환경변수
# (OPENRND_CRED_<ID>)의 기준이 됩니다 → id "jira" ⇒ OPENRND_CRED_JIRA.
SYSTEM = {
    "id": "jira",
    "name": "사내 Jira",
    "description": "사내 Jira REST API. Personal Access Token 필요.",
}


def can_handle(url: str) -> bool:
    return urlparse(url).hostname == "jira.corp.com"


def fetch(url: str) -> str:
    print(f"사내 Jira 조회: {url}", file=sys.stderr)        # 로그는 stderr 로
    token = os.environ.get("OPENRND_CRED_JIRA")            # 등록된 키가 주입됨
    res = requests.get(url, timeout=15,
                       headers={"Authorization": f"Bearer {token}"})
    res.raise_for_status()
    return res.text        # ← 본문 문자열 반환
```

**반환값에 따른 동작 (중요):**

| `fetch` 반환값             | 결과                                                   |
| -------------------------- | ------------------------------------------------------ |
| 공백이 아닌 문자열         | **성공** — 그 내용을 사용하고 ★브라우저 폴백을 건너뜀★ |
| 빈 문자열 `""` 또는 공백만 | 실패로 간주 → 다음 핸들러(없으면 브라우저)로 진행      |
| 예외(raise)                | 실패로 간주(에러 로깅) → 다음 단계로 진행              |

`dispatch.py` 가 `handlers/` 의 모든 핸들러를 자동 검색해, `can_handle(url)` 이
`True` 인 첫 핸들러의 `fetch(url)` 결과를 사용합니다.

### API 키(자격증명) 관리 — 프롬프트로 등록

사내 시스템 키는 핸들러 코드에 넣지 않고, **프롬프트로 등록**해서 관리합니다.
`manage_credential` 도구가 이를 처리합니다.

```
# 등록
> 사내 jira 키는 abc123 이야. 등록해줘
  → manage_credential set(system="jira", value="abc123")

# 목록 (어떤 시스템에 키가 필요한지, 등록 여부 확인 — 값은 안 보여줌)
> 등록된 사내 키 목록 보여줘
  → manage_credential list

# 삭제
> jira 키 삭제해줘
  → manage_credential remove(system="jira")
```

동작 방식:

1. **시스템 식별**: 각 핸들러의 `SYSTEM["id"]`(예: `jira`)가 키의 식별자입니다.
   `list` 는 `handlers/` 의 `SYSTEM` 메타데이터를 읽어 사용자에게 안내합니다.
2. **저장**: 키는 `~/.openrnd/credentials.json` 에 `chmod 600` 으로 저장됩니다
   (git 범위 밖, 평문 — 공유 PC 에서는 주의). 값은 화면에 다시 노출되지
   않습니다.
3. **주입**: fetch 실행 시 등록된 키가 환경변수 `OPENRND_CRED_<ID>` 로 핸들러에
   주입됩니다. id `jira` ⇒ `OPENRND_CRED_JIRA`, `wiki-corp` ⇒
   `OPENRND_CRED_WIKI_CORP` (영숫자 외 문자는 `_`, 전부 대문자).

핸들러는 그 환경변수를 **읽기만** 하면 됩니다:

```python
token = os.environ.get("OPENRND_CRED_JIRA")
```

### 규약 / 팁

- **stdout = 본문 전용.** 본문 외의 출력을 stdout 으로 내보내지 마세요.
- **로그는 `print(..., file=sys.stderr)`.** stderr 한 줄이 openrnd 대화 터미널에
  `🐍` 접두로 바로 표시됩니다(디버깅·감사 로그용).
- **API 키는 `manage_credential` 로 등록** →
  `os.environ.get("OPENRND_CRED_<ID>")` 로 읽기. 키를 핸들러 코드/깃에
  하드코딩하지 마세요.
- **의존성**: `requests` 등은 시스템 Python 3(`python3`/Windows `python`)에 미리
  설치돼 있어야 합니다. (`run_python` 도구와 동일 전제)

### 수정 후 반영

```bash
npm run bundle
```

Python 핸들러는 빌드 시 `bundle/corporate_fetchers/` 로 복사됩니다. 핸들러를
추가/수정한 뒤 위 명령으로 재번들해야 배포본에 반영됩니다.

### 관련 환경변수 (선택)

| 환경변수                              | 기본값 | 설명                                                          |
| ------------------------------------- | ------ | ------------------------------------------------------------- |
| `OPENRND_WEBFETCH_BROWSER_FALLBACK`   | 켜짐   | `0`/`false`/`off` 로 설정 시 2·3단계 폴백을 끄고 1단계만 사용 |
| `OPENRND_WEBFETCH_MIN_CONTENT_LENGTH` | `5000` | 이 크기(byte) 이하 200 응답을 SSO 로그인 스텁으로 간주        |
| `OPENRND_WEBFETCH_BROWSER_WAIT_MS`    | `5000` | 브라우저로 열 때 페이지 렌더링 대기 시간(ms)                  |

---

## 설정 파일

`~/.openrnd/settings.json` — 사용자 전역 설정

```json
{
  "llm": {
    "baseUrl": "https://your-api.com/v1",
    "model": "your-model-name",
    "apiKey": "your-api-key"
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/work"]
    }
  }
}
```

`.openrnd/settings.json` — 프로젝트별 설정 (워크스페이스 스코프)

`~/.openrnd/skills/` — 사용자 Skill 저장 위치

`~/.openrnd/credentials.json` — 사내 fetch API 키 (chmod 600,
`manage_credential` 도구가 관리, git 범위 밖)

---

## 대화형 모드 슬래시 명령어

| 명령어           | 설명                    |
| ---------------- | ----------------------- |
| `/help`          | 사용 가능한 명령어 목록 |
| `/skills list`   | 설치된 skill 목록       |
| `/skills reload` | skill 다시 로드         |
| `/mcp`           | MCP 서버 상태 확인      |
| `/clear`         | 대화 내역 초기화        |
| `/quit`          | 종료                    |

---

## 빌드 스크립트

소스(`packages/**`)를 수정한 뒤에는 **반드시 재빌드**해야 반영됩니다. 실행
바이너리(`openrnd`)는 `bundle/` 디렉터리의 번들 파일을 실행하기 때문입니다.

```bash
# 이것 하나로 충분 (prebundle이 bundle/ 자동 정리 → core 빌드 → 번들링)
npm run bundle
```

`npm run bundle` 내부 순서:

1. `prebundle` — `bundle/` 디렉터리 정리 (Node `fs.rmSync`, Windows 호환)
2. `generate` — git 커밋 정보 생성
3. **`build --workspace=@openrnd/core` — core를 `tsc`로 `dist/`에 컴파일
   (필수)**
4. `build` (devtools) — 클라이언트 에셋 빌드
5. `bundle:browser-mcp` — browser MCP 번들
6. `esbuild.config.js` — CLI(`packages/cli`) 번들링 → `bundle/`
7. `copy_bundle_assets.js` — 정책·문서·Skill 파일 복사

> **중요:** esbuild는 CLI 진입점만 소스에서 직접 번들링하고, `@openrnd/core`는
> 패키지(`dist/index.js`)로 해석합니다. 그래서 `packages/core/**`를 수정하면
> 반드시 core를 먼저 `tsc`로 빌드해야 반영됩니다. 위 3번 단계가 이를 처리하므로
> `npm run bundle`만 실행하면 됩니다. (예전엔 이 단계가 빠져 있어서 core 소스를
> 고쳐도 stale `dist/`가 번들링되는 함정이 있었음.)

---

## 프로젝트 구조

```
openrnd/
├── packages/
│   ├── core/                    # 핵심 로직 (TypeScript)
│   │   └── src/
│   │       ├── core/
│   │       │   └── openaiCompatibleContentGenerator.ts  # LLM 어댑터
│   │       └── tools/
│   │           ├── python-exec.ts      # Python 실행 도구
│   │           ├── manage-mcp.ts       # MCP 관리 도구
│   │           ├── manage-skill.ts     # Skill 관리 도구
│   │           ├── web-fetch.ts            # URL 수집 + 3단계 폴백 체인
│   │           ├── corporate-fetch.ts      # 사내 fetch → Python 디스패처 브리지
│   │           ├── corporate-credentials.ts # API 키 저장(~/.openrnd/credentials.json)
│   │           ├── manage-credential.ts    # manage_credential 도구(프롬프트 등록)
│   │           └── corporate_fetchers/     # ★ 사내 URL별 Python 핸들러
│   │               ├── dispatch.py
│   │               └── handlers/           #   <도메인>.py 하나씩 추가
│   └── cli/                     # CLI 진입점
│       └── src/
│           └── commands/
│               └── llm.ts           # llm set/show/test 커맨드
├── bundle/                      # 빌드 산출물
└── .env.example                 # 환경변수 예시
```

---

## 라이선스

Apache 2.0 — Google Gemini CLI 기반 포크.
