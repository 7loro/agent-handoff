import type { SessionMeta, TimingReport, ToolName } from "./types.js";
import { TOOL_NAMES } from "./adapters/index.js";
import { pathsEqual } from "./util.js";

/** catalog.ListOptions 와 동일 형태 — 순환 import 방지용 로컬 타입 */
export interface MockListOptions {
  days: number;
  tools?: ToolName[];
  cwd: string;
  cwdOnly?: boolean;
  limit?: number;
}

export interface MockListResult {
  sessions: SessionMeta[];
  timing: TimingReport;
}

/** README / 스크린샷용 고정 시각 (정렬이 흔들리지 않게) */
const NOW = Date.UTC(2026, 7, 10, 9, 30, 0); // 2026-08-10 09:30 UTC

function hoursAgo(h: number): number {
  return NOW - h * 60 * 60 * 1000;
}

function daysAgo(d: number): number {
  return NOW - d * 24 * 60 * 60 * 1000;
}

/**
 * 목 세션 — cwd 세션 3 + 다른 프로젝트 여러 개.
 * `opts.cwd` 를 현재 폴더 경로로 써서 [cwd] 배지가 실제로 보이게 한다.
 */
export function buildMockSessions(cwd: string): SessionMeta[] {
  const otherA = "/Users/demo/Workspace/piccoma-app";
  const otherB = "/Users/demo/Workspace/infra-tools";
  const otherC = "/Users/demo/Projects/side/oauth-lab";

  const rows: Array<Omit<SessionMeta, "path" | "mtimeMs" | "size"> & { path?: string }> = [
    {
      tool: "claude",
      sessionId: "mock-claude-oauth-001",
      projectPath: cwd,
      title: "OAuth refresh token race in mobile client",
      snippet: "Fix concurrent refresh — single-flight mutex",
      updatedAt: hoursAgo(0.5),
    },
    {
      tool: "codex",
      sessionId: "mock-codex-picker-002",
      projectPath: cwd,
      title: "Vim-style session picker layout polish",
      snippet: "j/k navigation + Tab agent filter",
      updatedAt: hoursAgo(2),
    },
    {
      tool: "grok",
      sessionId: "mock-grok-timing-003",
      projectPath: cwd,
      title: "Calibrate AH_DAYS budget under 500ms",
      snippet: "bench days=1,3,7,14 on this machine",
      updatedAt: hoursAgo(5),
    },
    {
      tool: "gemini",
      sessionId: "mock-gemini-resume-004",
      projectPath: otherA,
      title: "Resume Gemini checkpoint after handoff",
      snippet: "write turns into native session format",
      updatedAt: hoursAgo(8),
    },
    {
      tool: "claude",
      sessionId: "mock-claude-review-005",
      projectPath: otherA,
      title: "PR review: adapter meta-cache invalidation",
      snippet: "path+mtime+size key collisions",
      updatedAt: daysAgo(1),
    },
    {
      tool: "codex",
      sessionId: "mock-codex-deploy-006",
      projectPath: otherB,
      title: "Ship npm package ahandoff + ahf bin",
      snippet: "prepublishOnly build, LICENSE notice",
      updatedAt: daysAgo(1.5),
    },
    {
      tool: "grok",
      sessionId: "mock-grok-search-007",
      projectPath: otherC,
      title: "Why not full-history semantic search?",
      snippet: "recent-window handoff vs agent-hop",
      updatedAt: daysAgo(2),
    },
    {
      tool: "claude",
      sessionId: "mock-claude-hangul-008",
      projectPath: otherB,
      title: "한글 IME 검색 입력과 NFD/NFC 정규화",
      snippet: "picker / search draft normalize",
      updatedAt: daysAgo(3),
    },
    {
      tool: "codex",
      sessionId: "mock-codex-gemini-009",
      projectPath: otherC,
      title: "Add Gemini CLI adapter scan/extract",
      snippet: "project_root + session JSON front slice",
      updatedAt: daysAgo(4),
    },
    {
      tool: "gemini",
      sessionId: "mock-gemini-docs-010",
      projectPath: otherA,
      title: "Document demo mode with mock sessions",
      snippet: "just mock / ahf --mock for fixture picker",
      updatedAt: daysAgo(5),
    },
  ];

  return rows.map((r, i) => {
    const path = r.path ?? `${r.projectPath}/.mock/sessions/${r.sessionId}.jsonl`;
    return {
      tool: r.tool,
      sessionId: r.sessionId,
      projectPath: r.projectPath,
      title: r.title,
      snippet: r.snippet,
      path,
      mtimeMs: r.updatedAt,
      size: 12_000 + i * 900,
      updatedAt: r.updatedAt,
      raw: { mock: true },
    };
  });
}

export function listMockSessions(opts: MockListOptions): MockListResult {
  const tools = opts.tools?.length ? opts.tools : TOOL_NAMES;
  const toolSet = new Set<ToolName>(tools);
  const cwd = opts.cwd;
  let sessions = buildMockSessions(cwd).filter((s) => toolSet.has(s.tool));

  if (opts.cwdOnly) {
    sessions = sessions.filter((s) => pathsEqual(s.projectPath, cwd));
  }

  // 실제 listSessions 와 동일한 정렬: cwd first → updatedAt desc
  sessions.sort((a, b) => {
    const aCwd = pathsEqual(a.projectPath, cwd) ? 1 : 0;
    const bCwd = pathsEqual(b.projectPath, cwd) ? 1 : 0;
    if (aCwd !== bCwd) return bCwd - aCwd;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.tool.localeCompare(b.tool) || a.sessionId.localeCompare(b.sessionId);
  });

  const limit = opts.limit ?? 50;
  sessions = sessions.slice(0, limit);
  const cwd_sessions = sessions.filter((s) => pathsEqual(s.projectPath, cwd)).length;

  const timing: TimingReport = {
    event: "list_ready",
    elapsed_ms: 42,
    days: opts.days,
    since: new Date(NOW - opts.days * 24 * 60 * 60 * 1000).toISOString(),
    tools,
    project_cwd: cwd,
    counts: {
      candidates: sessions.length + 3,
      parsed: 0,
      cache_hit: sessions.length,
      cache_miss: 0,
      sessions: sessions.length,
      cwd_sessions,
    },
    phases_ms: { scan_ms: 8, extract_ms: 12, store_ms: 1, rank_ms: 2 },
    per_tool_ms: Object.fromEntries(tools.map((t) => [t, 3])) as Partial<Record<ToolName, number>>,
  };

  return { sessions, timing };
}

export function isMockMode(flag?: boolean): boolean {
  if (flag === true) return true;
  const v = process.env.AH_MOCK;
  return v === "1" || v === "true" || v === "yes";
}
