import {
  readFileSync,
  statSync,
  readdirSync,
  createReadStream,
  openSync,
  readSync,
  closeSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { ToolCallRecord, Turn } from "./types.js";

export function readJsonlLines(path: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip
    }
  }
  return out;
}

export async function* readJsonlLinesLazy(path: string): AsyncGenerator<Record<string, unknown>> {
  let stream;
  try {
    stream = createReadStream(path, { encoding: "utf-8" });
  } catch {
    return;
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // skip
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** 파일 앞부분만 읽어 메타 추출용 (대용량 JSONL에 안전) */
export function readHeadText(path: string, maxBytes = 64 * 1024): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, 0);
    return buffer.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * 재귀 파일 탐색. sinceMs가 있으면 mtime이 그보다 오래된 파일은 건너뜀.
 * 디렉터리 mtime만으로는 안전하지 않아 파일 단위로 stat.
 */
export function findFilesSince(
  root: string,
  matches: (path: string) => boolean,
  sinceMs: number,
  maxDepth = 8
): { path: string; mtimeMs: number; size: number }[] {
  const out: { path: string; mtimeMs: number; size: number }[] = [];
  if (!existsSync(root)) return out;

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (matches(full) && st.mtimeMs >= sinceMs) {
        out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }
  walk(root, 0);
  return out;
}

export const MIN_TITLE_CHARS = 15;
export const MAX_TOOL_OUTPUT_CHARS = 3000;
export const CONVERSION_CHAR_BUDGET = 200_000;

export function cleanTitle(raw: string): string {
  let text = raw.trim().replace(/\s+/g, " ");
  const leadingUrl = text.match(/^https?:\/\/\S+\s*/);
  if (leadingUrl) {
    const rest = text.slice(leadingUrl[0].length).trim();
    if (rest.length >= MIN_TITLE_CHARS) text = rest;
  }
  const MAX = 80;
  if (text.length <= MAX) return text;
  const cut = text.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > MAX * 0.6 ? cut.slice(0, lastSpace) : cut;
  return trimmed.trimEnd() + "…";
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…(truncated, ${s.length - max} more chars)` : s;
}

function turnCharCount(t: Turn): number {
  let n = t.text.length;
  for (const tc of t.toolCalls ?? []) n += tc.input.length + (tc.output?.length ?? 0);
  return n;
}

export function trimTurnsToBudget(
  turns: Turn[],
  budget = CONVERSION_CHAR_BUDGET
): { turns: Turn[]; droppedCount: number } {
  let total = 0;
  let cutIndex = turns.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    total += turnCharCount(turns[i]);
    if (total > budget) {
      cutIndex = i + 1;
      break;
    }
    cutIndex = i;
  }
  return { turns: turns.slice(cutIndex), droppedCount: cutIndex };
}

export function sameProject(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "");
  try {
    return norm(realpathSync(a)) === norm(realpathSync(b));
  } catch {
    return norm(a) === norm(b);
  }
}

/** 경로 동일 여부 — realpath 우선, 실패 시 정규화 문자열 비교 */
export function pathsEqual(a: string, b: string): boolean {
  return sameProject(a, b);
}

/** 마지막 메시지 시각 표시 (정렬 기준과 동일 필드) */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function folderName(projectPath: string): string {
  return projectPath.split("/").filter(Boolean).pop() ?? projectPath;
}
