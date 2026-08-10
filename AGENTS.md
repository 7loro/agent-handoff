## 프로젝트 개요

`ahandoff`(명령어 `ahf` / `ahandoff`) — 로컬 코딩 에이전트(Claude Code, Codex, Grok, Gemini) 간 **최근 세션 핸드오프** CLI.
전체 히스토리 시맨틱 검색 도구가 아니라 "컨텍스트가 찼으니 지금 다른 에이전트로 이어가기" 순간에 최적화되어 있다.
TypeScript ESM(NodeNext, strict), 런타임 의존성은 `commander` + `@clack/prompts` 둘뿐.

## 명령어

```bash
npm run build               # tsc -p . && chmod +x dist/cli.js
npm run dev                 # tsx src/cli.ts (개발 실행)
just run -- list --days 3   # 개발 실행 (인자 전달)
just mock                   # 목 데이터로 피커 실행 (디스크 스캔 없음)
just link                   # 빌드 후 npm install -g . (ahf 전역 연결)
just clean                  # dist 삭제
```

- 테스트 프레임워크 없음 (test 스크립트 없음).
- 실 세션 스캔 없이 UI/피커를 확인하려면 `--mock` 또는 `AH_MOCK=1` (`src/mock-data.ts` 픽스처 사용).
- 주요 env: `AH_DAYS`(기본 7, lookback), `AH_BUDGET_MS`(기본 500, 타이밍 힌트 임계), `AH_TIMING=1`(타이밍 JSON 강제).

## 아키텍처

CLI 진입점 `src/cli.ts`(commander)에 서브커맨드 4개: `pick`(기본 — 인터랙티브 선택 후 hop), `list`, `hop`, `bench`.

핵심 파이프라인은 `src/catalog.ts`의 `listSessions` 3단계:

1. **scan** — 어댑터별 `scanCandidates(sinceMs)`가 mtime stat만으로 후보 열거 (본문 파싱 없음)
2. **extract** — 후보별 `extractMeta`, 그 전에 `MetaStore`(`~/.cache/ahandoff/meta-v1.json`) 캐시 조회.
   캐시 키는 `tool:path`, mtime+size 불일치 시 무효화 (`src/meta-store.ts`)
3. **rank** — cwd 프로젝트 세션 우선, 그 안에서 `updatedAt` 내림차순. `--cwd-only`가 아니면 다른 프로젝트도 뒤에 표시

**어댑터 패턴** (`src/adapters/`): 에이전트별로 `Adapter` 인터페이스(`src/types.ts`)를 구현 —
`scanCandidates` / `extractMeta` / `read`(전체 턴 파싱, hop 시에만 호출) / `write`(턴을 대상 에이전트 포맷으로 저장) / `resumeCmd`.
새 에이전트 지원은 어댑터 파일 추가 + `src/adapters/index.ts`의 `ADAPTERS` 등록이 전부다.
각 어댑터는 해당 CLI의 로컬 세션 저장소를 직접 읽는다 — Claude는 `~/.claude/projects/**/*.jsonl`,
Codex는 `YYYY/MM/DD` 디렉토리로 프루닝, Grok은 `summary.json`만으로 목록 구성.

**hop 흐름** (`src/cli.ts`의 `hopSession`): 소스 `read` → `trimTurnsToBudget`(예산 초과 시 오래된 턴 드랍) →
대상 `write` → `resumeCmd`를 execve(가능하면) 또는 spawn으로 실행. 소스=대상이면 변환 없이 네이티브 resume.

**피커** (`src/picker.ts`): 직접 구현한 vim 스타일 TUI (j/k, g/G, Tab 에이전트 필터, `/` 검색, 한글 키 레이아웃 대응).
비 TTY(파이프)에서는 탭 구분 정적 출력으로 폴백.

## 설계 불변식 (수정 시 유지할 것)

- **목록 단계에서 세션 본문을 파싱하지 않는다.** 전체 턴 파싱(`read`)은 hop 시에만. list가 느려지는 변경 금지.
- **mtime 프루닝** — lookback 윈도우보다 오래된 파일은 열지 않는다.
- **관측 가능성 계약** — 모든 list/hop은 stderr에 머신 라인(`AH_TIMING ...`, `AH_CONVERT ...`)과 사람용 타이밍을 출력한다. 새 경로를 추가해도 이 계약을 유지할 것.
- **stdout은 데이터 전용** (JSON, 탭 구분 선택 결과), 타이밍·진단은 stderr — 파이프/스크립트 사용을 전제로 한다.

## 문서

README.md(영어)와 README.ko.md(한국어)가 병행 유지된다. 사용자 노출 동작(명령, 옵션, env, 키 바인딩)을 바꾸면 두 파일을 함께 갱신할 것.
