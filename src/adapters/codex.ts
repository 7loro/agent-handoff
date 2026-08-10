import { mkdirSync, writeFileSync, realpathSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Adapter, SessionCandidate, SessionMeta, Turn, ToolCallRecord, Attachment } from "../types.js";
import {
  readJsonlLines,
  readJsonlLinesLazy,
  cleanTitle,
  truncate,
  MAX_TOOL_OUTPUT_CHARS,
  MIN_TITLE_CHARS,
} from "../util.js";

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function codexCliVersion(): string {
  try {
    const out = execFileSync("codex", ["--version"], { encoding: "utf-8" });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1]! : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const ENV_PREFIXES = [
  "<environment_context>",
  "# Context from my IDE",
  "# AGENTS.md instructions",
  "<recommended_plugins>",
];

/** YYYY/MM/DD 폴더 prune — 최근 N일 폴더만 순회 */
function dayDirsSince(sinceMs: number): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const out: string[] = [];
  const since = new Date(sinceMs);
  // UTC 날짜 디렉터리 (codex 저장 방식)
  const cursor = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  const end = new Date();
  const endUtc = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  // 여유 1일
  cursor.setUTCDate(cursor.getUTCDate() - 1);

  while (cursor.getTime() <= endUtc.getTime() + 86400000) {
    const y = cursor.getUTCFullYear();
    const m = pad(cursor.getUTCMonth() + 1);
    const d = pad(cursor.getUTCDate());
    const dir = join(SESSIONS_DIR, String(y), m, d);
    if (existsSync(dir)) out.push(dir);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

async function scanCandidates(sinceMs: number): Promise<SessionCandidate[]> {
  const out: SessionCandidate[] = [];
  for (const dayDir of dayDirsSince(sinceMs)) {
    let entries: string[];
    try {
      entries = readdirSync(dayDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const full = join(dayDir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs) continue;
      out.push({ tool: "codex", path: full, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

async function extractMeta(candidate: SessionCandidate): Promise<SessionMeta | null> {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let firstUserText = "";
  let titleText = "";
  let lines = 0;
  const MAX_LINES = 100;

  for await (const obj of readJsonlLinesLazy(candidate.path)) {
    lines++;
    if (obj.type === "session_meta") {
      const payload = obj.payload as { id?: string; cwd?: string } | undefined;
      sessionId = payload?.id;
      cwd = payload?.cwd;
      continue;
    }
    if (obj.type !== "response_item") {
      if (lines >= MAX_LINES) break;
      continue;
    }
    const payload = obj.payload as { type?: string; role?: string; content?: unknown } | undefined;
    if (payload?.type !== "message" || !Array.isArray(payload.content)) continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;
    const parts = payload.content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          ["input_text", "output_text", "text"].includes((b as { type?: string }).type ?? "")
      )
      .map((b) => b.text);
    const text = parts.join("\n").trim();
    if (!text || ENV_PREFIXES.some((p) => text.startsWith(p))) continue;
    const isShellPaste = /^\S+@\S+\s.*[%$#]\s/.test(text);
    if (payload.role === "user") {
      if (!firstUserText && !isShellPaste) firstUserText = text;
      if (!titleText && text.length >= MIN_TITLE_CHARS && !isShellPaste) titleText = text;
    }
    if (sessionId && cwd && titleText) break;
    if (lines >= MAX_LINES) break;
  }

  if (!sessionId || !cwd) return null;
  const title =
    cleanTitle(titleText || firstUserText) ||
    `(${cwd.split("/").pop()}, no readable content)`;
  return {
    tool: "codex",
    sessionId,
    projectPath: cwd,
    title,
    snippet: title.slice(0, 200),
    path: candidate.path,
    mtimeMs: candidate.mtimeMs,
    size: candidate.size,
    updatedAt: candidate.mtimeMs,
    raw: { file: candidate.path },
  };
}

function extractCodexAttachments(content: unknown[]): Attachment[] {
  return content
    .filter(
      (b): b is { type: string; image_url: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: string }).type === "input_image" &&
        typeof (b as { image_url?: unknown }).image_url === "string"
    )
    .map((b) => {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(b.image_url);
      return m ? { mimeType: m[1]!, base64: m[2]! } : null;
    })
    .filter((x): x is Attachment => x !== null);
}

async function read(meta: SessionMeta): Promise<Turn[]> {
  const file = (meta.raw?.file as string) ?? meta.path;
  const lines = readJsonlLines(file);
  const turns: Turn[] = [];
  let assistantTextParts: string[] = [];
  let pendingToolCalls: ToolCallRecord[] = [];
  let pendingAttachments: Attachment[] = [];
  const callIndex = new Map<string, ToolCallRecord>();

  const flushAssistant = () => {
    const text = assistantTextParts.join("\n\n").trim();
    if (text || pendingToolCalls.length > 0 || pendingAttachments.length > 0) {
      turns.push({
        role: "assistant",
        text,
        toolCalls: pendingToolCalls.length ? pendingToolCalls : undefined,
        attachments: pendingAttachments.length ? pendingAttachments : undefined,
      });
    }
    assistantTextParts = [];
    pendingToolCalls = [];
    pendingAttachments = [];
    callIndex.clear();
  };

  for (const obj of lines) {
    if (obj.type !== "response_item") continue;
    const payload = obj.payload as {
      type?: string;
      role?: string;
      content?: unknown;
      name?: string;
      arguments?: string;
      input?: string;
      output?: unknown;
      call_id?: string;
    } | undefined;
    if (!payload) continue;

    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const rec: ToolCallRecord = {
        name: payload.name ?? "unknown_tool",
        input: (payload.type === "function_call" ? payload.arguments : payload.input) ?? "",
      };
      pendingToolCalls.push(rec);
      if (payload.call_id) callIndex.set(payload.call_id, rec);
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const rec = payload.call_id ? callIndex.get(payload.call_id) : undefined;
      if (rec) {
        const out = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output);
        rec.output = truncate(out, MAX_TOOL_OUTPUT_CHARS);
      }
      continue;
    }
    if (payload.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;
    if (!Array.isArray(payload.content)) continue;

    const parts = payload.content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          ["input_text", "output_text", "text"].includes((b as { type?: string }).type ?? "")
      )
      .map((b) => b.text);
    const text = parts.join("\n").trim();
    if (ENV_PREFIXES.some((p) => text.startsWith(p))) continue;
    const attachments = extractCodexAttachments(payload.content);

    if (payload.role === "user") {
      flushAssistant();
      if (text || attachments.length) {
        turns.push({
          role: "user",
          text,
          attachments: attachments.length ? attachments : undefined,
        });
      }
    } else {
      if (text) assistantTextParts.push(text);
      if (attachments.length) pendingAttachments.push(...attachments);
    }
  }
  flushAssistant();
  return turns;
}

async function write(turns: Turn[], projectPath: string): Promise<string> {
  let realCwd = projectPath;
  try {
    realCwd = realpathSync(projectPath);
  } catch {
    mkdirSync(projectPath, { recursive: true });
    realCwd = realpathSync(projectPath);
  }

  const newId = randomUUID();
  const now = new Date();
  const dateDir = join(
    SESSIONS_DIR,
    `${now.getUTCFullYear()}`,
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate())
  );
  mkdirSync(dateDir, { recursive: true });
  const fnameTs = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
  const outPath = join(dateDir, `rollout-${fnameTs}-${newId}.jsonl`);

  const lines: string[] = [
    JSON.stringify({
      timestamp: now.toISOString(),
      type: "session_meta",
      payload: {
        id: newId,
        timestamp: now.toISOString(),
        cwd: realCwd,
        originator: "codex_cli_rs",
        cli_version: codexCliVersion(),
        instructions: null,
        source: "cli",
        model_provider: "openai",
      },
    }),
  ];

  for (const turn of turns) {
    const ts = new Date().toISOString();
    const nonImageNote = (turn.attachments ?? [])
      .filter((a) => !a.mimeType.startsWith("image/"))
      .map((a) => `[attached file: ${a.filename ?? "unnamed"} (${a.mimeType})]`)
      .join("\n");
    const combinedText = [turn.text, nonImageNote].filter(Boolean).join("\n\n");
    const content: Record<string, unknown>[] = [];
    if (combinedText) {
      content.push({
        type: turn.role === "user" ? "input_text" : "output_text",
        text: combinedText,
      });
    }
    for (const img of (turn.attachments ?? []).filter((a) => a.mimeType.startsWith("image/"))) {
      content.push({ type: "input_image", image_url: `data:${img.mimeType};base64,${img.base64}` });
    }
    if (content.length > 0) {
      lines.push(
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: { type: "message", role: turn.role, content },
        })
      );
    }
    for (const tc of turn.toolCalls ?? []) {
      const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      lines.push(
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: { type: "function_call", name: tc.name, arguments: tc.input, call_id: callId },
        })
      );
      lines.push(
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: { type: "function_call_output", call_id: callId, output: tc.output ?? "" },
        })
      );
    }
    if (content.length === 0 && !(turn.toolCalls ?? []).length) continue;
    lines.push(
      JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload:
          turn.role === "user"
            ? { type: "user_message", message: combinedText || "[image attached]" }
            : { type: "agent_message", message: combinedText || "[tool call]", phase: "commentary" },
      })
    );
  }
  writeFileSync(outPath, lines.join("\n") + "\n");
  return newId;
}

function resumeCmd(sessionId: string, _projectPath: string): string[] {
  return ["codex", "resume", sessionId];
}

export const codexAdapter: Adapter = {
  tool: "codex",
  scanCandidates,
  extractMeta,
  read,
  write,
  resumeCmd,
};
