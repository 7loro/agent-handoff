import type { SessionMeta, TimingReport, ToolName } from "./types.js";
import { ADAPTERS, TOOL_NAMES } from "./adapters/index.js";
import { MetaStore } from "./meta-store.js";
import { nowMs } from "./timing.js";
import { pathsEqual } from "./util.js";
import { isMockMode, listMockSessions } from "./mock-data.js";

export interface ListOptions {
  days: number;
  tools?: ToolName[];
  cwd: string;
  /** true면 현재 cwd 세션만 (기본 false = 전체 스캔) */
  cwdOnly?: boolean;
  limit?: number;
  /** true면 디스크 스캔 없이 목 세션 (데모/스크린샷) */
  mock?: boolean;
}

export interface ListResult {
  sessions: SessionMeta[];
  timing: TimingReport;
}

export async function listSessions(opts: ListOptions): Promise<ListResult> {
  if (isMockMode(opts.mock)) {
    return listMockSessions(opts);
  }

  const tools = opts.tools?.length ? opts.tools : TOOL_NAMES;
  const sinceMs = Date.now() - opts.days * 24 * 60 * 60 * 1000;
  const store = new MetaStore();
  const t0 = nowMs();

  const perToolMs: Partial<Record<ToolName, number>> = {};
  let candidates = 0;
  let cacheHit = 0;
  let cacheMiss = 0;
  let parsed = 0;

  // --- scan ---
  const tScan0 = nowMs();
  const candidateLists = await Promise.all(
    tools.map(async (tool) => {
      const t = nowMs();
      try {
        const list = await ADAPTERS[tool].scanCandidates(sinceMs);
        perToolMs[tool] = Math.round(nowMs() - t);
        return list;
      } catch {
        perToolMs[tool] = Math.round(nowMs() - t);
        return [];
      }
    })
  );
  const allCandidates = candidateLists.flat();
  candidates = allCandidates.length;
  const scan_ms = Math.round(nowMs() - tScan0);

  // --- extract (cache-aware) ---
  const tExtract0 = nowMs();
  const metas: SessionMeta[] = [];
  await Promise.all(
    allCandidates.map(async (c) => {
      const hit = store.get(c.tool, c.path, c.mtimeMs, c.size);
      if (hit) {
        cacheHit++;
        // 기간 필터 재확인 (캐시 히트여도)
        if (hit.updatedAt >= sinceMs) metas.push(hit);
        return;
      }
      cacheMiss++;
      try {
        const meta = await ADAPTERS[c.tool].extractMeta(c);
        if (!meta) return;
        parsed++;
        store.set(meta);
        if (meta.updatedAt >= sinceMs) metas.push(meta);
      } catch {
        // skip broken session
      }
    })
  );
  const extract_ms = Math.round(nowMs() - tExtract0);

  // --- store flush ---
  const tStore0 = nowMs();
  store.flush();
  const store_ms = Math.round(nowMs() - tStore0);

  // --- rank: cwd first, then recency ---
  const tRank0 = nowMs();
  let filtered = metas;
  if (opts.cwdOnly) {
    filtered = metas.filter((m) => pathsEqual(m.projectPath, opts.cwd));
  }

  // 1) 현재 작업 폴더 세션 먼저
  // 2) 그 안에서는 마지막 메시지/활동 시각(updatedAt) 최신순
  filtered.sort((a, b) => {
    const aCwd = pathsEqual(a.projectPath, opts.cwd) ? 1 : 0;
    const bCwd = pathsEqual(b.projectPath, opts.cwd) ? 1 : 0;
    if (aCwd !== bCwd) return bCwd - aCwd;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    // 동일 시각이면 에이전트 이름으로 안정 정렬
    return a.tool.localeCompare(b.tool) || a.sessionId.localeCompare(b.sessionId);
  });

  const limit = opts.limit ?? 50;
  const sessions = filtered.slice(0, limit);
  const cwd_sessions = sessions.filter((s) => pathsEqual(s.projectPath, opts.cwd)).length;
  const rank_ms = Math.round(nowMs() - tRank0);

  const elapsed_ms = Math.round(nowMs() - t0);
  const timing: TimingReport = {
    event: "list_ready",
    elapsed_ms,
    days: opts.days,
    since: new Date(sinceMs).toISOString(),
    tools,
    project_cwd: opts.cwd,
    counts: {
      candidates,
      parsed,
      cache_hit: cacheHit,
      cache_miss: cacheMiss,
      sessions: sessions.length,
      cwd_sessions,
    },
    phases_ms: { scan_ms, extract_ms, store_ms, rank_ms },
    per_tool_ms: perToolMs,
  };

  return { sessions, timing };
}

export function filterByQuery(sessions: SessionMeta[], query: string): SessionMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter(
    (s) =>
      s.title.toLowerCase().includes(q) ||
      s.snippet.toLowerCase().includes(q) ||
      s.projectPath.toLowerCase().includes(q) ||
      s.sessionId.toLowerCase().includes(q)
  );
}
