import type { SessionMeta, ToolName } from "./types.js";
import { TOOL_NAMES } from "./adapters/index.js";
import { formatDate, folderName, pathsEqual } from "./util.js";
import { toolTag, cwdBadge, dim, bold, color, forceToolColor } from "./theme.js";
import {
  clipAnsi,
  displayWidth,
  padPlain,
  stripAnsi,
  truncatePlain,
} from "./term-width.js";
import { isGoBottom, isGoTop, isMoveDown, isMoveUp, isQuit } from "./keys.js";

export type AgentFilter = "all" | ToolName;

const FILTER_CYCLE: AgentFilter[] = ["all", ...TOOL_NAMES];

export interface PickSessionOptions {
  sessions: SessionMeta[];
  cwd: string;
  initialQuery?: string;
  title?: string;
  /** 초기 커서 위치 (기본 0) */
  initialCursor?: number;
}

type ViewRow =
  | { kind: "header"; text: string }
  | { kind: "session"; sessionIndex: number; session: SessionMeta };

/**
 * vim 친화적 세션 피커.
 *
 * 검색:
 * - `/` 입력 중: 전체 목록 + 매칭 하이라이트
 * - Enter: 매칭만 필터 + 하이라이트 유지
 * - Esc(필터 중): 검색 취소 / Esc(없음): 종료
 */
export async function pickSession(opts: PickSessionOptions): Promise<SessionMeta | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return opts.sessions[0] ?? null;
  }

  const { sessions, cwd } = opts;
  let filter: AgentFilter = "all";
  let query = opts.initialQuery?.trim() ?? "";
  let cursor = Math.max(0, Math.min(sessions.length - 1, opts.initialCursor ?? 0));
  let scroll = 0;
  let mode: "nav" | "search" = "nav";
  let searchDraft = query;

  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw === true;

  stdout.write("\x1b[?1049h\x1b[?25l");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    stdout.write("\x1b[?25h\x1b[?1049l");
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      // ignore
    }
  };

  /** 검색어 정규화: 선행 `/` 제거 + NFC (macOS 한글 NFD/NFC 불일치 방지) */
  const normalizeNeedle = (raw: string): string => {
    return raw
      .normalize("NFC")
      .replace(/^\/+/u, "") // `/` 로 모드 진입 후 또 / 누른 경우
      .trim()
      .toLowerCase();
  };

  const haystack = (s: SessionMeta): string => {
    return `${s.title}\n${s.projectPath}\n${s.sessionId}\n${s.tool}`.normalize("NFC").toLowerCase();
  };

  const matchesSearch = (s: SessionMeta, needle: string): boolean => {
    const q = normalizeNeedle(needle);
    if (!q) return true;
    return haystack(s).includes(q);
  };

  const getDisplayList = (): SessionMeta[] => {
    let list = sessions;
    if (filter !== "all") list = list.filter((s) => s.tool === filter);
    if (mode === "nav" && normalizeNeedle(query)) {
      list = list.filter((s) => matchesSearch(s, query));
    }
    return list;
  };

  const highlightNeedle = (): string => {
    // 하이라이트/매칭용 — 선행 슬래시 제거된 값
    if (mode === "search") return normalizeNeedle(searchDraft);
    return normalizeNeedle(query);
  };

  const buildViewRows = (list: SessionMeta[]): ViewRow[] => {
    const rows: ViewRow[] = [];
    let sawCwd = false;
    let sawOther = false;
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      const isCwd = pathsEqual(s.projectPath, cwd);
      if (isCwd && !sawCwd) {
        rows.push({ kind: "header", text: dim("  ── current folder ──") });
        sawCwd = true;
      } else if (!isCwd && !sawOther) {
        rows.push({ kind: "header", text: dim("  ── other projects ──") });
        sawOther = true;
      }
      rows.push({ kind: "session", sessionIndex: i, session: s });
    }
    return rows;
  };

  const layout = () => {
    const termRows = Math.max(8, stdout.rows ?? 24);
    const termCols = Math.max(40, stdout.columns ?? 80);
    // 검색 모드: 상단 SEARCH 배너 + 입력 줄이 추가되어 chrome +2
    const chrome = mode === "search" ? 8 : query.trim() ? 7 : 6;
    const bodyBudget = Math.max(1, termRows - chrome);
    return { termRows, termCols, bodyBudget, chrome };
  };

  const focusRowIndex = (viewRows: ViewRow[], sessionCursor: number): number => {
    for (let i = 0; i < viewRows.length; i++) {
      const r = viewRows[i]!;
      if (r.kind === "session" && r.sessionIndex === sessionCursor) return i;
    }
    return 0;
  };

  const ensureScroll = (viewRows: ViewRow[], sessionCursor: number, bodyBudget: number) => {
    if (viewRows.length === 0) {
      scroll = 0;
      return;
    }
    const focus = focusRowIndex(viewRows, sessionCursor);
    if (focus < scroll) scroll = focus;
    if (focus >= scroll + bodyBudget) scroll = focus - bodyBudget + 1;
    const maxScroll = Math.max(0, viewRows.length - bodyBudget);
    scroll = Math.max(0, Math.min(scroll, maxScroll));
  };

  /** 고정 컬럼 행 — plain 폭으로 맞춘 뒤 컬럼별 색만 입혀 줄바꿈 방지 */
  const formatSessionRow = (
    s: SessionMeta,
    selected: boolean,
    needle: string,
    faded: boolean,
    termCols: number
  ): string => {
    const isCwd = pathsEqual(s.projectPath, cwd);
    // 컬럼: ›(1) sp tool(6) sp sp title(?) sp sp date(16) sp sp loc(rest)
    const TOOL_W = 6;
    const DATE_W = 16;
    const LOC_W = Math.min(14, Math.max(8, Math.floor(termCols * 0.15)));
    // pointer + spaces + tool + gaps + date + gaps + loc
    const fixed = 1 + 1 + TOOL_W + 2 + 2 + DATE_W + 2 + LOC_W;
    const titleW = Math.max(8, termCols - fixed - 1);

    const titlePlain = padPlain(s.title, titleW);
    const datePlain = padPlain(formatDate(s.updatedAt), DATE_W);
    const locPlain = padPlain(
      isCwd ? `cwd:${folderName(s.projectPath)}` : folderName(s.projectPath),
      LOC_W
    );

    const ptr = selected ? "›" : " ";
    let toolCol: string;
    let titleCol: string;
    let dateCol: string;
    let locCol: string;

    if (faded) {
      toolCol = dim(padPlain(s.tool, TOOL_W));
      titleCol = dim(titlePlain);
      dateCol = dim(datePlain);
      locCol = dim(locPlain);
    } else {
      toolCol = toolTag(s.tool, TOOL_W);
      titleCol = needle
        ? highlightMatch(titlePlain, needle)
        : isCwd
          ? bold(titlePlain)
          : titlePlain;
      dateCol = dim(datePlain);
      if (isCwd) {
        // cwd 라벨 짧게 + 폴더
        const raw = truncatePlain(folderName(s.projectPath), Math.max(4, LOC_W - 4));
        const folderPart = needle ? highlightMatch(padPlain(raw, Math.max(4, LOC_W - 4)), needle) : padPlain(raw, Math.max(4, LOC_W - 4));
        locCol = `${cwdBadge()} ${folderPart}`;
        // loc 전체 폭이 넘치면 plain clip
        if (displayWidth(stripAnsi(locCol)) > LOC_W + 6) {
          locCol = dim(padPlain(`cwd:${folderName(s.projectPath)}`, LOC_W));
        }
      } else {
        locCol = needle ? dim(highlightMatch(locPlain, needle)) : dim(locPlain);
      }
    }

    // 선택: 포인터만 강하게 (전체 반전은 ANSI/한글 폭과 섞이면 깨지기 쉬움)
    const ptrCol = selected ? color.yellow(bold(ptr)) : ptr;
    let line = `${ptrCol} ${toolCol}  ${titleCol}  ${dateCol}  ${locCol}`;
    // 최종 안전장치: 터미널 폭 초과 시 절단 (줄바꿈 = 레이아웃 붕괴)
    line = clipAnsi(line, termCols - 1);
    if (selected) {
      // 줄 전체에 약한 배경 — clip 이후에 감싸서 폭 안정
      line = `\x1b[48;5;236m${line}\x1b[0m`;
    }
    return line;
  };

  const render = () => {
    const list = getDisplayList();
    if (list.length === 0) cursor = 0;
    else cursor = Math.max(0, Math.min(list.length - 1, cursor));

    const { termCols, bodyBudget } = layout();
    const viewRows = buildViewRows(list);
    ensureScroll(viewRows, cursor, bodyBudget);
    const needle = highlightNeedle();
    const matchCount = needle ? list.filter((s) => matchesSearch(s, needle)).length : list.length;

    const lines: string[] = [];
    const w = termCols - 1;

    // ── 상단: 모드가 한눈에 들어오게 ──
    if (mode === "search") {
      // 노란 역상 SEARCH 배너 — 모드 진입이 즉시 보이게
      const banner = padPlain("  SEARCH  ·  type to filter  ·  Enter apply  ·  Esc cancel  ", w);
      lines.push(`\x1b[43;30;1m${banner}\x1b[0m`);
      // 입력 줄 (선행 / 는 표시·매칭 모두 무시)
      const draftShow = searchDraft.replace(/^\/+/u, "");
      const prompt = padPlain(`  / ${draftShow}█`, w);
      lines.push(`\x1b[48;5;236m${prompt}\x1b[0m`);
      lines.push(
        clipAnsi(
          color.yellow(bold(`  ${matchCount}`)) +
            dim(` match in ${list.length}`) +
            dim("  ·  non-matching rows dimmed"),
          w
        )
      );
    } else {
      lines.push(clipAnsi(bold(opts.title ?? "ahandoff"), w));
      if (normalizeNeedle(query)) {
        // 필터 적용 중 — 보라/노란 바로 표시
        const bar = `  FILTER  /${normalizeNeedle(query)}   ·  ${list.length} results  ·  Esc clears search  `;
        lines.push(clipAnsi(`\x1b[45;97;1m${padPlain(bar, w)}\x1b[0m`, w));
      } else {
        lines.push(
          clipAnsi(dim(`${list.length}/${sessions.length} sessions`) + dim("  · last-msg · cwd first"), w)
        );
      }
      lines.push("");
    }

    const bodyLines: string[] = [];
    if (viewRows.length === 0) {
      bodyLines.push(dim("  (no matches — Tab filter · / search)"));
    } else {
      const end = Math.min(viewRows.length, scroll + bodyBudget);
      for (let i = scroll; i < end; i++) {
        const row = viewRows[i]!;
        if (row.kind === "header") {
          bodyLines.push(clipAnsi(row.text, w));
          continue;
        }
        const s = row.session;
        const selected = row.sessionIndex === cursor;
        const isMatch = !needle || matchesSearch(s, needle);
        const faded = mode === "search" && !!needle && !isMatch;
        bodyLines.push(formatSessionRow(s, selected, needle, faded, termCols));
      }
    }
    while (bodyLines.length < bodyBudget) bodyLines.push("");
    lines.push(...bodyLines.slice(0, bodyBudget));

    lines.push(dim("─".repeat(Math.min(w, 76))));
    lines.push(clipAnsi(renderFilterBar(filter), w));
    if (mode === "search") {
      lines.push(clipAnsi(dim("  typing…  Enter = keep matches only  ·  Esc = leave search (keep list)"), w));
    } else if (normalizeNeedle(query)) {
      lines.push(clipAnsi(dim("j/k move · Esc clear filter · / edit search · Enter select · q quit"), w));
    } else if (termCols < 72) {
      lines.push(clipAnsi(dim("j/k|ㅓㅏ move · Tab · / · Enter · q|ㅂ"), w));
    } else {
      lines.push(
        clipAnsi(
          dim("j/k ㅓ/ㅏ ↑↓ move · g/ㅎ top · Tab filter · / search · Enter · q/ㅂ quit"),
          w
        )
      );
    }

    const maxLines = Math.max(1, (stdout.rows ?? 24) - 1);
    stdout.write("\x1b[H\x1b[J");
    stdout.write(lines.slice(0, maxLines).join("\n"));
  };

  return new Promise<SessionMeta | null>((resolve) => {
    const finish = (value: SessionMeta | null) => {
      stdin.off("data", onData);
      stdout.off("resize", onResize);
      cleanup();
      resolve(value);
    };

    const onResize = () => render();
    stdout.on("resize", onResize);

    const onData = (chunk: string | Buffer) => {
      const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");

      if (key === "\x03") {
        finish(null);
        return;
      }

      if (mode === "search") {
        if (key === "\x1b") {
          // 검색 입력 취소 → nav (적용된 필터는 유지)
          mode = "nav";
          searchDraft = query;
          render();
          return;
        }
        if (key === "\r" || key === "\n") {
          // 선행 / 제거 후 적용
          query = normalizeNeedle(searchDraft);
          searchDraft = query;
          mode = "nav";
          cursor = 0;
          scroll = 0;
          render();
          return;
        }
        if (key === "\x7f" || key === "\b") {
          // 유니코드 한 글자 단위 삭제 (한글 음절 OK)
          const chars = [...searchDraft];
          chars.pop();
          searchDraft = chars.join("");
          render();
          return;
        }
        // CSI / 제어 무시
        if (key.startsWith("\x1b") || key === "\x03") return;
        // 인쇄 가능 문자 — 한글 IME/멀티바이트 청크 포함 (length===1 제한 금지)
        const printable = [...key].filter((ch) => {
          const cp = ch.codePointAt(0)!;
          return cp >= 0x20 && cp !== 0x7f;
        }).join("");
        if (!printable) return;
        // 빈 draft 에서 `/` 만 또 누르면 무시 (//세션 방지)
        if (printable === "/" && searchDraft.replace(/^\/+/u, "") === "") {
          render();
          return;
        }
        searchDraft += printable;
        // 실수로 붙은 선행 슬래시는 입력 중에도 정리
        if (searchDraft.startsWith("/")) {
          searchDraft = searchDraft.replace(/^\/+/u, "");
        }
        render();
        return;
      }

      const list = getDisplayList();

      // q / ㅂ (한글 두벌식) — 영문 자판 아니어도 종료
      if (isQuit(key)) {
        finish(null);
        return;
      }

      if (key === "\x1b" && key.length === 1) {
        if (normalizeNeedle(query)) {
          query = "";
          searchDraft = "";
          cursor = 0;
          scroll = 0;
          render();
          return;
        }
        finish(null);
        return;
      }

      // j/k + 화살표 + 한글 ㅓ/ㅏ (두벌식 같은 물리 키) + 전각 ｊｋ
      if (isMoveDown(key)) {
        cursor = Math.min(Math.max(0, list.length - 1), cursor + 1);
        render();
        return;
      }
      if (isMoveUp(key)) {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (isGoTop(key)) {
        cursor = 0;
        scroll = 0;
        render();
        return;
      }
      if (isGoBottom(key)) {
        cursor = Math.max(0, list.length - 1);
        render();
        return;
      }
      if (key === "\x04") {
        const { bodyBudget } = layout();
        cursor = Math.min(Math.max(0, list.length - 1), cursor + Math.max(1, Math.floor(bodyBudget / 2)));
        render();
        return;
      }
      if (key === "\x15") {
        const { bodyBudget } = layout();
        cursor = Math.max(0, cursor - Math.max(1, Math.floor(bodyBudget / 2)));
        render();
        return;
      }

      if (key === "\t") {
        const idx = FILTER_CYCLE.indexOf(filter);
        filter = FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length]!;
        cursor = 0;
        scroll = 0;
        render();
        return;
      }
      if (key === "\x1b[Z") {
        const idx = FILTER_CYCLE.indexOf(filter);
        filter = FILTER_CYCLE[(idx - 1 + FILTER_CYCLE.length) % FILTER_CYCLE.length]!;
        cursor = 0;
        scroll = 0;
        render();
        return;
      }

      if (key === "/") {
        mode = "search";
        // 기존 필터가 있으면 수정, 없으면 빈 입력부터
        searchDraft = query;
        render();
        return;
      }

      if (key === "\r" || key === "\n") {
        finish(list[cursor] ?? null);
        return;
      }

      if (key.startsWith("\x1b[") && key.length > 1) return;
    };

    render();
    stdin.on("data", onData);
  });
}

function renderFilterBar(active: AgentFilter): string {
  const parts = FILTER_CYCLE.map((name) => {
    if (name === active) {
      if (name === "all") return bold("[all]");
      return forceToolColor(name, `[${name}]`);
    }
    return dim(name);
  });
  return dim("agent ") + parts.join("  ") + dim("   Tab cycle");
}

/** plain 텍스트 안 needle 하이라이트 (NFC 기준) */
function highlightMatch(text: string, needle: string): string {
  const q = needle.normalize("NFC").replace(/^\/+/u, "").trim();
  if (!q) return text;
  // 원본 표시는 유지하되 매칭은 NFC 기준으로 위치 계산
  const textN = text.normalize("NFC");
  const lower = textN.toLowerCase();
  const n = q.toLowerCase();
  // pad 된 문자열은 이미 NFC에 가깝다고 가정하고 text 기준 탐색
  // (pad 스페이스는 ASCII라 NFC 전후 동일 인덱스)
  let out = "";
  let i = 0;
  const src = text; // 표시용
  const srcLower = src.normalize("NFC").toLowerCase();
  while (i < src.length) {
    const idx = srcLower.indexOf(n, i);
    if (idx === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, idx);
    out += `\x1b[1;33m${src.slice(idx, idx + n.length)}\x1b[0m`;
    i = idx + n.length;
  }
  return out;
}
