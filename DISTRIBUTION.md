# 배포 가이드 (내 PC = 정적 서버)

`@openwork/cli`를 **공용 npm 레지스트리 없이**, 내 PC를 정적 파일 서버로 써서
사용자에게 한 줄 명령으로 배포하는 방법입니다.

## 동작 원리

- esbuild 번들(`bundle/`)이 모든 JS 의존성을 인라인하므로, 배포 tarball은 런타임
  `dependencies`가 **0개**입니다.
- 따라서 설치 시 **네트워크/빌드 없이** tarball 하나만 풀면 끝입니다 (사내
  폐쇄망에서도 동작).
- 네이티브 모듈(node-pty, keytar)은 optional이며 없으면 자동 폴백합니다.

## 배포자(나) — 2단계

### 1. tarball 빌드

```bash
npm run release:pack
```

- `bundle/`을 새로 빌드하고, 의존성 없는 slim `package.json`으로 패킹합니다.
- 결과물:
  - `release/openwork-cli-<version>.tgz` (버전 고정)
  - `release/openwork-latest.tgz` (항상 최신 별칭)

### 2. 내 PC에서 서빙

```bash
npm run release:serve
```

- `release/` 폴더를 HTTP로 제공합니다(기본 포트 8723, `OPENWORK_RELEASE_PORT`로
  변경).
- 실행하면 사내망 IP별 설치 명령을 그대로 출력해줍니다, 예:

  ```
  npm install -g http://192.168.0.105:8723/openwork-latest.tgz
  ```

> 이 PC가 켜져 있고 같은 네트워크에서 접근 가능해야 합니다. 방화벽에서 해당
> 포트를 열어주세요.

## 사용자 — 한 줄 설치

전제: **Node.js 20 이상**이 설치되어 있어야 합니다.

```bash
npm install -g http://<배포PC-IP>:8723/openwork-latest.tgz
```

설치 후:

```bash
openwork --version
openwork
```

### 업데이트

배포자가 `release:pack`을 다시 돌리면 `openwork-latest.tgz`가 갱신됩니다.
사용자는 같은 설치 명령을 다시 실행하면 최신 버전으로 덮어쓰기됩니다.

### 제거

```bash
npm uninstall -g @openwork/cli
```

## 참고: 네이티브 모듈 / Windows

- 기본 tarball은 네이티브 PTY(node-pty)·OS 키체인(keytar) 없이도 동작합니다
  (셸은 child_process 폴백, 자격증명은 파일 폴백).
- Windows 사용자가 더 풍부한 인터랙티브 셸이 필요하면 플랫폼별 네이티브 모듈을
  tarball에 포함하도록 확장할 수 있습니다(요청 시 추가).
- Windows에서는 설치 시 `postinstall`이 DRM Office 읽기에 필요한 `pywin32`를
  best-effort로 설치합니다(실패해도 설치는 깨지지 않음).
