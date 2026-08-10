import type { TimingReport } from "./types.js";

/** 사람용 + 에이전트용 타이밍 출력 (stderr) */
export function printTiming(report: TimingReport, budgetMs = 500): void {
  const line =
    `AH_TIMING elapsed_ms=${report.elapsed_ms} days=${report.days} sessions=${report.counts.sessions} ` +
    `candidates=${report.counts.candidates} cache_hit=${report.counts.cache_hit} cache_miss=${report.counts.cache_miss} ` +
    `scan_ms=${report.phases_ms.scan_ms} extract_ms=${report.phases_ms.extract_ms} ` +
    `store_ms=${report.phases_ms.store_ms} rank_ms=${report.phases_ms.rank_ms}`;

  // 에이전트 파싱용 한 줄 (고정 prefix)
  console.error(line);

  // 사람용 요약
  const tools = report.tools.join(",");
  console.error(
    `⏱  list ready in ${report.elapsed_ms}ms  (days=${report.days}, tools=${tools})`
  );
  console.error(
    `   scan  ${String(report.phases_ms.scan_ms).padStart(4)}ms  candidates=${report.counts.candidates}  ` +
      `parsed=${report.counts.parsed}  cache_hit=${report.counts.cache_hit}  cache_miss=${report.counts.cache_miss}`
  );
  console.error(
    `   sessions: ${report.counts.sessions}  (cwd first: ${report.counts.cwd_sessions})`
  );

  const perTool = Object.entries(report.per_tool_ms)
    .map(([k, v]) => `${k}=${v}ms`)
    .join(" ");
  if (perTool) console.error(`   per_tool: ${perTool}`);

  if (report.elapsed_ms > budgetMs) {
    const suggested = suggestDays(report.days, report.elapsed_ms, budgetMs);
    console.error(
      `hint: list took ${report.elapsed_ms}ms (>${budgetMs}ms budget). Try --days ${suggested} (or AH_DAYS=${suggested}).`
    );
  }
}

export function printTimingJson(report: TimingReport): void {
  console.error(JSON.stringify(report));
}

function suggestDays(currentDays: number, elapsedMs: number, budgetMs: number): number {
  if (elapsedMs <= budgetMs) return currentDays;
  const ratio = budgetMs / elapsedMs;
  const next = Math.max(1, Math.floor(currentDays * ratio));
  // 관측값 기반 단순 제안 — 1/3/7 계단 중 아래로
  const steps = [1, 3, 7, 14, 30];
  const under = steps.filter((d) => d <= next);
  return under.length ? under[under.length - 1]! : 1;
}

export function nowMs(): number {
  return performance.now();
}
