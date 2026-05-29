# openrnd

업무용 AI CLI — OpenAI-compatible LLM에 연결하는 터미널 에이전트.

Google Gemini CLI를 기반으로 바이브 코딩 기능을 제거하고, 크롤링·데이터
처리·자동화·MCP 연동 등 실무 작업에 특화한 경량 CLI입니다.

---

## 주요 기능

| 기능                       | 설명                                                     |
| -------------------------- | -------------------------------------------------------- |
| **OpenAI-compatible 연결** | Ollama, LM Studio, OpenAI, vLLM 등 모든 호환 서비스 지원 |
| **Python 실행**            | 크롤링·데이터 처리 스크립트를 대화 중 직접 실행          |
| **MCP 서버 관리**          | 프롬프트 한 줄로 MCP 서버 추가/삭제                      |
| **Skill 관리**             | 프롬프트로 재사용 가능한 워크플로 Skill 생성/관리        |
| **파일 조작**              | 읽기·쓰기·편집, 검색, 디렉터리 탐색                      |
| **웹 검색 / 페이지 수집**  | 웹 검색 및 URL 콘텐츠 가져오기                           |
| **셸 실행**                | 백그라운드 프로세스 포함 임의 명령 실행                  |

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

변경 후 재빌드:

```bash
# core만 변경한 경우
npm run build --workspace=@openrnd/core

# cli만 변경한 경우
npm run build --workspace=@openrnd/cli

# 번들 전체 재생성 (배포용)
npm run build --workspace=@openrnd/core
npm run build --workspace=@openrnd/cli
node esbuild.config.js
node scripts/copy_bundle_assets.js
```

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
│   │           ├── python-exec.ts   # Python 실행 도구
│   │           ├── manage-mcp.ts    # MCP 관리 도구
│   │           └── manage-skill.ts  # Skill 관리 도구
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
