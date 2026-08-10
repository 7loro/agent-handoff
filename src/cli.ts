#!/usr/bin/env node
import { Command } from "commander";
import * as p from "@clack/prompts";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { listSessions, filterByQuery } from "./catalog.js";
import { ADAPTERS, TOOL_NAMES } from "./adapters/index.js";
import { printTiming, printTimingJson } from "./timing.js";
import { trimTurnsToBudget, formatDate, folderName, pathsEqual } from "./util.js";
import { toolTag, cwdBadge, dim, bold } from "./theme.js";
import { pickSession } from "./picker.js";
import { isMockMode } from "./mock-data.js";
import type { SessionMeta, ToolName } from "./types.js";

const DEFAULT_DAYS = Number(process.env.AH_DAYS ?? 7);
const BUDGET_MS = Number(process.env.AH_BUDGET_MS ?? 500);

function useMock(opts: { mock?: boolean }): boolean {
  // 서브커맨드 플래그 + 전역 `--mock` + AH_MOCK
  return isMockMode(Boolean(opts.mock) || Boolean(program.opts().mock));
}

function parseTools(raw?: string): ToolName[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()) as ToolName[];
  for (const t of parts) {
    if (!TOOL_NAMES.includes(t)) {
      console.error(`Unknown tool "${t}". Valid: ${TOOL_NAMES.join(", ")}`);
      process.exit(1);
    }
  }
  return parts;
}

function resolveExecutable(cmd: string): string | null {
  if (cmd.includes("/")) return existsSync(cmd) ? cmd : null;
  try {
    const out = execFileSync("which", [cmd], { encoding: "utf-8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function hopSession(
  picked: SessionMeta,
  target: ToolName,
  opts: { printCmd?: boolean; json?: boolean }
): Promise<void> {
  const source = ADAPTERS[picked.tool];
  const dest = ADAPTERS[target];
  let projectPath = picked.projectPath;
  if (!existsSync(projectPath)) {
    console.error(`warn: project path missing (${projectPath}), using home`);
    projectPath = homedir();
  }

  let sessionId = picked.sessionId;
  const t0 = performance.now();

  if (target !== picked.tool) {
    const allTurns = await source.read(picked);
    if (allTurns.length === 0) {
      console.error("No readable turns.");
      process.exit(1);
    }
    const { turns, droppedCount } = trimTurnsToBudget(allTurns);
    sessionId = await dest.write(turns, projectPath);
    const convert_ms = Math.round(performance.now() - t0);
    console.error(
      `AH_CONVERT convert_ms=${convert_ms} turns=${turns.length} dropped=${droppedCount} ` +
        `from=${picked.tool} to=${target} sessionId=${sessionId}`
    );
    console.error(
      `converted ${turns.length}/${allTurns.length} turns in ${convert_ms}ms` +
        (droppedCount ? ` (dropped oldest ${droppedCount})` : "")
    );
  }

  const cmd = dest.resumeCmd(sessionId, projectPath);
  if (opts.json) {
    console.log(JSON.stringify({ sessionId, projectPath, cmd, from: picked.tool, to: target }));
    return;
  }
  if (opts.printCmd) {
    console.log(cmd.join(" "));
    return;
  }

  console.error(`launching: ${cmd.join(" ")}`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.removeAllListeners();
  process.stdin.pause();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const execve =
    typeof (process as any).execve === "function"
      ? ((process as any).execve as (path: string, args: string[], env: Record<string, string>) => never)
      : undefined;

  if (execve && process.platform !== "win32") {
    const resolved = resolveExecutable(cmd[0]!);
    if (resolved && existsSync(resolved)) {
      process.chdir(projectPath);
      execve(resolved, cmd, process.env as Record<string, string>);
    }
  }

  const child = spawn(cmd[0]!, cmd.slice(1), { cwd: projectPath, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

/**
 * 정렬: cwd 세션 우선 → 그 안에서는 updatedAt(마지막 활동/메시지 시각) 내림차순.
 * 표시: 에이전트별 색상, cwd 라벨, 마지막 메시지 시각.
 */
function printSessionList(sessions: SessionMeta[], cwd: string): void {
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }
  let lastCwdBlock: boolean | null = null;
  for (const s of sessions) {
    const isCwd = pathsEqual(s.projectPath, cwd);
    if (lastCwdBlock === true && !isCwd) {
      console.log(dim("── other projects ──"));
    } else if (lastCwdBlock === null && isCwd) {
      console.log(dim("── current folder ──"));
    }
    lastCwdBlock = isCwd;

    const tool = toolTag(s.tool);
    const when = dim(formatDate(s.updatedAt));
    const folder = folderName(s.projectPath);
    const titleRaw = s.title.length > 56 ? s.title.slice(0, 55) + "…" : s.title;
    const title = isCwd ? bold(titleRaw.padEnd(58)) : titleRaw.padEnd(58);
    const loc = isCwd ? `${cwdBadge()} ${folder}` : dim(folder);
    console.log(`${tool}  ${title} ${when}  ${loc}`);
  }
}

const program = new Command();
program
  .name("ahf")
  .description("ahandoff — fast recent-session handoff (claude/codex/grok/gemini)")
  .version("0.1.0")
  .option("--mock", "use fixture sessions (demo)", false);

program
  .command("list")
  .description("List recent sessions (all projects, cwd first)")
  .option("-d, --days <n>", "lookback days", String(DEFAULT_DAYS))
  .option("-a, --agent <tools>", "comma-separated: claude,codex,grok,gemini")
  .option("--cwd-only", "only sessions from current directory", false)
  .option("-q, --query <text>", "filter title/path")
  .option("-n, --limit <n>", "max results", "200")
  .option("--json", "JSON on stdout; timing still on stderr", false)
  .option("--timing-json", "full timing JSON on stderr", false)
  .option("--mock", "use fixture sessions", false)
  .action(async (opts) => {
    const days = Number(opts.days);
    const tools = parseTools(opts.agent);
    const cwd = process.cwd();
    const mock = useMock(opts);
    const { sessions, timing } = await listSessions({
      days,
      tools,
      cwd,
      cwdOnly: Boolean(opts.cwdOnly),
      limit: Number(opts.limit),
      mock,
    });

    if (opts.timingJson || process.env.AH_TIMING === "1") printTimingJson(timing);
    else printTiming(timing, BUDGET_MS);

    if (opts.json) {
      const filtered = opts.query ? filterByQuery(sessions, opts.query) : sessions;
      console.log(JSON.stringify({ sessions: filtered, timing }, null, 2));
      return;
    }

    // TTY면 vim 피커 (필터/검색은 피커 안에서), 아니면 정적 덤프
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const picked = await pickSession({
        sessions,
        cwd,
        initialQuery: opts.query,
        title: mock ? "ahandoff · sessions (mock)" : "ahandoff · sessions",
      });
      if (!picked) process.exit(0);
      // list 모드: 선택만 출력 (hop 안 함)
      console.log(
        `${picked.tool}\t${picked.sessionId}\t${picked.title}\t${picked.projectPath}`
      );
      return;
    }
    const filtered = opts.query ? filterByQuery(sessions, opts.query) : sessions;
    printSessionList(filtered, cwd);
  });

program
  .command("bench")
  .description("Measure list latency for multiple day windows")
  .option("--days <list>", "comma-separated day windows", "1,3,7,14")
  .option("-a, --agent <tools>", "comma-separated tools")
  .option("--mock", "use fixture sessions", false)
  .action(async (opts) => {
    const dayList = String(opts.days)
      .split(",")
      .map((s: string) => Number(s.trim()))
      .filter((n: number) => n > 0);
    const tools = parseTools(opts.agent);
    const mock = useMock(opts);
    console.log("days  sessions  elapsed_ms  candidates  cache_hit  cache_miss");
    let suggested = dayList[0] ?? 7;
    for (const days of dayList) {
      const { sessions, timing } = await listSessions({
        days,
        tools,
        cwd: process.cwd(),
        limit: 200,
        mock,
      });
      console.log(
        `${String(days).padEnd(5)} ${String(sessions.length).padEnd(9)} ${String(timing.elapsed_ms).padEnd(11)} ` +
          `${String(timing.counts.candidates).padEnd(11)} ${String(timing.counts.cache_hit).padEnd(10)} ${timing.counts.cache_miss}`
      );
      console.error(
        `AH_TIMING elapsed_ms=${timing.elapsed_ms} days=${days} sessions=${sessions.length} ` +
          `candidates=${timing.counts.candidates} cache_hit=${timing.counts.cache_hit} cache_miss=${timing.counts.cache_miss}`
      );
      if (timing.elapsed_ms <= BUDGET_MS) suggested = days;
    }
    console.log(`\nsuggested_days: ${suggested}   # under ${BUDGET_MS}ms budget (AH_BUDGET_MS)`);
  });

program
  .command("hop")
  .description("Convert & resume a session in another agent")
  .requiredOption("-t, --to <tool>", `target agent (${TOOL_NAMES.join("|")})`)
  .option("-f, --from <tool>", "source agent", "claude")
  .option("-d, --days <n>", "lookback days", String(DEFAULT_DAYS))
  .option("--id <sessionId>", "explicit session id")
  .option("-q, --query <text>", "filter by title/path")
  .option("--cwd-only", "only current project sessions", false)
  .option("--latest", "take newest match without prompt", false)
  .option("--print-cmd", "print resume command only", false)
  .option("--json", "print result JSON", false)
  .option("--mock", "use fixture sessions", false)
  .action(async (opts) => {
    const from = opts.from as ToolName;
    const to = opts.to as ToolName;
    if (!TOOL_NAMES.includes(from) || !TOOL_NAMES.includes(to)) {
      console.error(`Valid tools: ${TOOL_NAMES.join(", ")}`);
      process.exit(1);
    }

    const mock = useMock(opts);
    const { sessions, timing } = await listSessions({
      days: Number(opts.days),
      tools: [from],
      cwd: process.cwd(),
      cwdOnly: Boolean(opts.cwdOnly),
      limit: 100,
      mock,
    });
    printTiming(timing, BUDGET_MS);

    let pool = sessions;
    if (opts.query) pool = filterByQuery(pool, opts.query);
    if (opts.id) {
      pool = pool.filter((s) => s.sessionId === opts.id || s.sessionId.startsWith(opts.id));
    }

    if (pool.length === 0) {
      console.error("No matching sessions.");
      process.exit(1);
    }

    let picked: SessionMeta;
    const nonInteractive =
      !process.stdin.isTTY || !process.stdout.isTTY || opts.latest || opts.id || opts.json;

    if (nonInteractive || pool.length === 1) {
      picked = pool[0]!;
      console.error(`picked: ${picked.tool} ${picked.title} (${picked.sessionId.slice(0, 8)}…)`);
    } else {
      const choice = await pickSession({
        sessions: pool,
        cwd: process.cwd(),
        initialQuery: opts.query,
        title: mock ? `ahandoff · hop ${from} → ${to} (mock)` : `ahandoff · hop ${from} → ${to}`,
      });
      if (!choice) process.exit(0);
      picked = choice;
    }

    await hopSession(picked, to, { printCmd: Boolean(opts.printCmd), json: Boolean(opts.json) });
  });

// `ahf` / `ahf <query>` — interactive pick
program
  .command("pick", { isDefault: true })
  .description("Interactive session pick (default)")
  .argument("[query]", "optional title filter")
  .option("-d, --days <n>", "lookback days", String(DEFAULT_DAYS))
  .option("-a, --agent <tools>", "comma-separated tools")
  .option("-r, --resume-in <tool>", "hop into this agent after pick")
  .option("--cwd-only", "only current project", false)
  .option("--mock", "use fixture sessions", false)
  .action(async (query: string | undefined, opts) => {
    const days = Number(opts.days);
    const tools = parseTools(opts.agent);
    const cwd = process.cwd();
    const mock = useMock(opts);
    const { sessions, timing } = await listSessions({
      days,
      tools,
      cwd,
      cwdOnly: Boolean(opts.cwdOnly),
      limit: 200,
      mock,
    });
    printTiming(timing, BUDGET_MS);

    if (sessions.length === 0) {
      console.log("No sessions found. Try --days 14 or remove --cwd-only.");
      return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      const pool = query ? filterByQuery(sessions, query) : sessions;
      for (const s of pool) {
        console.log(`${s.tool}\t${s.sessionId}\t${s.title}\t${s.projectPath}`);
      }
      return;
    }

    const picked = await pickSession({
      sessions,
      cwd,
      initialQuery: query,
      title: mock ? "ahandoff · pick session (mock)" : "ahandoff · pick session",
    });
    if (!picked) process.exit(0);

    let target: ToolName = opts.resumeIn as ToolName;
    if (!target || !TOOL_NAMES.includes(target)) {
      // 대상 에이전트도 간단히 순회 선택 (clack 유지 — 4개뿐)
      const t = await p.select({
        message: `Resume in which agent? (from ${picked.tool})`,
        options: TOOL_NAMES.map((name) => ({
          value: name,
          label: name === picked.tool ? `${name} (native resume)` : name,
        })),
        initialValue: picked.tool,
      });
      if (p.isCancel(t)) process.exit(0);
      target = t as ToolName;
    }

    await hopSession(picked, target, {});
  });

program.parse();
