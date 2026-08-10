# ahandoff

**Language:** [English](README.md) · [한국어](README.ko.md)

[![npm](https://img.shields.io/npm/v/ahandoff.svg)](https://www.npmjs.com/package/ahandoff)
[![npm](https://img.shields.io/npm/dt/ahandoff.svg)](https://www.npmjs.com/package/ahandoff)

![ahandoff 세션 피커](assets/capture.png)

로컬 코딩 에이전트 간 **최근 세션 빠른 핸드오프**.

- **npm:** [ahandoff](https://www.npmjs.com/package/ahandoff)
- **명령:** `ahf` (별칭: `ahandoff`)
- **에이전트:** Claude Code, Codex, Grok Build, Gemini CLI
- **기본 기간:** 최근 **7일** (`--days` / `AH_DAYS`로 조절)
- **범위:** 전체 프로젝트(기본). **현재 cwd 세션을 먼저** 표시
- **항상 타이밍 출력** — 머신에 맞게 lookback을 조정할 수 있음

> 전체 히스토리 시맨틱 검색 도구가 아닙니다.  
> 이 도구가 최적화하는 것: *“컨텍스트가 찼다 — 지금 다른 에이전트에서 이어가기.”*

## 목적과 철학

`ahandoff`의 목적은 **과거 작업을 찾는 것(retrieval)이 아니라, 지금 작업을 이어가는 것(continuity)**입니다. 컨텍스트나 토큰 한도로 작업이 끊겼을 때, 방금 하던 일을 다른 코딩 에이전트로 넘기는 데 집중합니다. 이 순간 필요한 세션은 대부분 수개월 전의 임의 세션이 아니라 가장 최근에 작업한 몇 개 중 하나입니다.

따라서 최근 기간만 탐색하는 것은 빠진 검색 기능이 아니라 의도적인 제품 경계입니다.

1. **전체보다 최근** — 실제 핸드오프 후보가 될 만한 소수의 세션만 보여줍니다.
2. **완전성보다 빠르고 예측 가능한 동작** — 전체 히스토리를 인덱싱하지 않고 mtime으로 오래된 파일을 제외합니다.
3. **본문보다 메타데이터 우선** — 목록은 가볍게 유지하고, 사용자가 세션을 골라 hop할 때만 전체 턴을 읽습니다.
4. **한 가지 문제에 집중** — 전체 히스토리 인덱싱, 시맨틱 회상, 과거 작업 검색은 그런 목적에 맞게 설계된 도구의 역할입니다.

`--days`와 `AH_DAYS`는 각자의 작업 주기에 맞게 **최근 범위**를 조절하기 위한 옵션이지, `ahandoff`를 전체 히스토리 검색 엔진으로 바꾸기 위한 기능이 아닙니다. 오래된 작업을 다시 찾아야 한다면 히스토리 검색 도구를, 방금 하던 작업을 이어가야 한다면 `ahandoff`를 사용하세요.

## [agent-hop](https://github.com/hetpatel-11/agent-hop) 대비

[agent-hop](https://github.com/hetpatel-11/agent-hop)은 **로컬 에이전트 전체 히스토리 검색**(하이브리드/시맨틱 검색, 임베딩, fuzzy) 후 세션을 resume·변환하는 넓은 도구입니다. *주제*는 기억나는데 어느 툴·폴더 세션인지 모를 때 적합합니다.

**ahandoff**는 그 아이디어를 **다른 순간**에 맞게 좁히고 빠르게 만든 버전입니다.

| | **agent-hop** | **ahandoff** |
|---|---|---|
| **역할** | 전체 히스토리에서 세션 찾기 | **최근** 세션을 *지금* 넘기기 |
| **검색** | 하이브리드 + 시맨틱 (ONNX embed, 백그라운드 인덱스) | 가벼운 제목/경로 필터 + 최신순 |
| **기본 기간** | 로컬 전체 히스토리 | 최근 **7일** (`--days` / `AH_DAYS`) |
| **목록 비용** | 다수 세션 open/index 가능 | **mtime prune** — 오래된 파일은 열지 않음 |
| **캐시** | `~/.agent-hop` 벡터 인덱스 | 작은 **메타 캐시** (path+mtime+size) |
| **본문 / turns** | 검색 품질을 위해 필요 | **hop 시에만** 로드 — list는 가볍게 |
| **정렬** | 검색 랭크 + 최신순 | **cwd-first**, 그다음 최신순 (cwd-only 아님) |
| **지연시간** | 인덱스·임베딩에 따라 변동 | **항상 타이밍 출력**; `ahf bench`로 days 보정 |
| **에이전트 I/O** | 인터랙티브 + 스크립트 hop | stderr 기계 라인: `AH_TIMING`, `AH_CONVERT` |
| **에이전트** | Claude, Codex, OpenCode, Pi, Grok | Claude, Codex, Grok, **Gemini** |

### “지금 핸드오프” 경로에서 개선한 점

1. **속도 우선 파이프라인** — mtime으로만 후보 스캔, 디스크 메타 캐시로 extract, 변환할 때만 전체 turns 파싱. 목표는 일반 머신에서 목록 1초 미만.
2. **보정 가능한 lookback** — `ahf bench --days 1,3,7,14`와 예산 힌트(`AH_BUDGET_MS`)로 지연 예산을 지키는 days를 고를 수 있음.
3. **cwd 인식 랭킹** — 현재 프로젝트 세션을 위로 올리되, 다른 프로젝트는 숨기지 않음 (`--cwd-only` 제외).
4. **관측 가능하도록 설계** — 모든 list/hop에 사람용·기계용 타이밍을 출력해 같은 방식으로 튜닝 가능.
5. **vim 스타일 피커** — `j/k`, `g/G`, Tab 필터 순환, `/` 검색, 한글 자판 친화 — 위저드보다 근육 기억.
6. **Gemini CLI** hop/resume 지원 (agent-hop은 OpenCode/Pi 쪽에 초점).

깊은 히스토리 검색이 필요하면 **agent-hop**, 최근 세션을 바로 다른 툴로 넘겨야 하면 **ahandoff**.

## 설치

**npm 패키지:** [https://www.npmjs.com/package/ahandoff](https://www.npmjs.com/package/ahandoff)

### 글로벌 설치 (권장)

```bash
npm install -g ahandoff

# 설치 후 두 이름 모두 사용 가능
ahf --help
ahandoff --help
```

**Node.js ≥ 18** 이 필요합니다.

### `npx`로 한 번 실행 (설치 없이)

```bash
npx ahandoff
npx ahandoff list
npx ahandoff --mock
npx ahandoff hop -f claude -t codex --latest
```

`npx`는 첫 실행 시 패키지를 받아 `ahandoff` CLI를 실행합니다. 글로벌 설치 없이 써 볼 때 적합합니다.

### 이 저장소에서 (개발)

```bash
# 의존성 설치, 빌드, 글로벌 연결
npm install
npm run build
npm install -g .

# 개발 중 링크
npm run build && npm link
```

## 목 데이터 데모

실제 에이전트 세션을 스캔하지 않고 피커를 실행합니다.

```bash
# 글로벌 설치 후
ahf --mock
# 또는
AH_MOCK=1 ahf

# npx
npx ahandoff --mock

# 이 저장소에서
just mock
```

## 사용법

```bash
# 인터랙티브 세션 목록 (vim 스타일 피커)
ahf
# 동일:
ahandoff
npx ahandoff

ahf list
npx ahandoff list

# 머신에 맞는 days 임계값 측정
ahf bench --days 1,3,7,14

# 최신 Claude 세션 → Codex 핸드오프
ahf hop -f claude -t codex --latest
npx ahandoff hop -f claude -t codex --latest

# 인터랙티브로 고른 뒤 hop
ahf hop -f claude -t grok
ahf "oauth" -r codex
```

글로벌 설치 후에는 `ahf`와 `ahandoff`가 동일합니다. `npx`를 쓸 때는 패키지 이름으로 `npx ahandoff …` 형태를 사용하세요.

### 피커 키 (vim 친화)

| 키 | 동작 |
|---|---|
| `j` / `k` · `↑` / `↓` | 이동 |
| `g` / `G` | 맨 위 / 맨 아래 |
| `Tab` / `Shift-Tab` | 에이전트 필터 순환 (`all` → claude → codex → grok → gemini) |
| `/` | 검색 (Enter 적용, Esc 취소) |
| `Enter` | 선택 |
| `q` / `Esc` | 종료 |

푸터에 에이전트 필터와 단축키 힌트가 항상 표시됩니다.

### 타이밍 출력

모든 `list` / `hop`은 **stderr**에 머신·사람 모두 읽을 수 있는 타이밍을 출력합니다.

```text
AH_TIMING elapsed_ms=187 days=7 sessions=6 candidates=48 cache_hit=42 cache_miss=6 scan_ms=112 extract_ms=71 ...
⏱  list ready in 187ms  (days=7, tools=claude,codex,grok,gemini)
   scan   112ms  candidates=48  parsed=6  cache_hit=42  cache_miss=6
   sessions: 6  (cwd first: 2)
```

- 에이전트용: `rg '^AH_TIMING'` 또는 환경변수 `AH_TIMING=1` / `--timing-json`
- 예산 초과 시 (`AH_BUDGET_MS`, 기본 500) `--days` 힌트를 출력

### 환경 변수

| 변수 | 기본값 | 의미 |
|---|---|---|
| `AH_DAYS` | `7` | 기본 lookback |
| `AH_BUDGET_MS` | `500` | 힌트 임계값 |
| `AH_TIMING` | off | stderr에 타이밍 JSON 강제 출력 |

메타 캐시: `~/.cache/ahandoff/meta-v1.json`

## 설계 메모

1. **mtime 우선** — 기간보다 오래된 파일은 열지 않음
2. **메타 캐시** — 동일 path+mtime+size → 재파싱 생략
3. **hop 시에만 body/전체 turns** — list는 가볍게 유지
4. **cwd-first 정렬** — cwd-only 필터가 아님 (`--cwd-only` 제외)
5. **Codex**는 `YYYY/MM/DD` 디렉터리로 prune; **Grok**은 `summary.json`만 목록에 사용

## Credits

**[agent-hop](https://github.com/hetpatel-11/agent-hop)** ([hetpatel-11](https://github.com/hetpatel-11))의 아이디어와 패턴을 참고했습니다 — 크로스 에이전트 세션 hop, 어댑터, “다른 곳에서 이어가기” UX. Shoutout 🙌

## License

MIT
