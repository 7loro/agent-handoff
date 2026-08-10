import type { ToolName } from "./types.js";

const c = {
  reset: "\x1b[0m",
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  // 에이전트별 고정 색 (256-color / basic ANSI) — 한눈에 구분
  claude: (s: string) => `\x1b[38;5;208m${s}\x1b[0m`, // orange
  codex: (s: string) => `\x1b[38;5;39m${s}\x1b[0m`, // blue
  grok: (s: string) => `\x1b[38;5;213m${s}\x1b[0m`, // pink/magenta
  gemini: (s: string) => `\x1b[38;5;45m${s}\x1b[0m`, // cyan
  cwd: (s: string) => `\x1b[38;5;82m${s}\x1b[0m`, // green
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const TOOL_COLOR: Record<ToolName, (s: string) => string> = {
  claude: c.claude,
  codex: c.codex,
  grok: c.grok,
  gemini: c.gemini,
};

/** 에이전트 이름 색칠 + 고정 폭 */
export function toolTag(tool: ToolName, width = 6): string {
  const label = tool.padEnd(width);
  if (!process.stdout.isTTY) return label;
  return TOOL_COLOR[tool](c.bold(label));
}

/** 현재 작업 폴더 세션 라벨 */
export function cwdBadge(): string {
  if (!process.stdout.isTTY) return "[cwd]";
  return c.cwd(c.bold("[cwd]"));
}

export function dim(s: string): string {
  if (!process.stdout.isTTY) return s;
  return c.dim(s);
}

export function bold(s: string): string {
  if (!process.stdout.isTTY) return s;
  return c.bold(s);
}

/** 강제 색칠 (TUI alternate screen에서도 stdout TTY) */
export function forceToolColor(tool: ToolName, text: string): string {
  return TOOL_COLOR[tool](c.bold(text));
}

export { c as color };
