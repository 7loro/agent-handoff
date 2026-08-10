import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Adapter, SessionCandidate, SessionMeta, Turn } from "../types.js";
import { cleanTitle, MIN_TITLE_CHARS } from "../util.js";

const GEMINI_HOME = existsSync(join(homedir(), ".gemini"))
  ? join(homedir(), ".gemini")
  : join(homedir(), ".config", "gemini");
const TMP_DIR = join(GEMINI_HOME, "tmp");
const HISTORY_DIR = join(GEMINI_HOME, "history");

/** project slug → absolute path (history/<slug>/.project_root) */
function loadProjectRoots(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(HISTORY_DIR)) return map;
  let slugs: string[];
  try {
    slugs = readdirSync(HISTORY_DIR);
  } catch {
    return map;
  }
  for (const slug of slugs) {
    const pr = join(HISTORY_DIR, slug, ".project_root");
    try {
      if (existsSync(pr)) {
        map.set(slug, readFileSync(pr, "utf-8").trim());
      }
    } catch {
      // skip
    }
  }
  return map;
}

async function scanCandidates(sinceMs: number): Promise<SessionCandidate[]> {
  if (!existsSync(TMP_DIR)) return [];
  const out: SessionCandidate[] = [];
  let projects: string[];
  try {
    projects = readdirSync(TMP_DIR);
  } catch {
    return [];
  }
  for (const proj of projects) {
    const chatsDir = join(TMP_DIR, proj, "chats");
    if (!existsSync(chatsDir)) continue;
    let files: string[];
    try {
      files = readdirSync(chatsDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
      const full = join(chatsDir, f);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs) continue;
      out.push({
        tool: "gemini",
        path: full,
        mtimeMs: st.mtimeMs,
        size: st.size,
        hints: { projectSlug: proj },
      });
    }
  }
  return out;
}

async function extractMeta(candidate: SessionCandidate): Promise<SessionMeta | null> {
  // 대용량 세션 JSON 전체 파싱 회피: 앞부분 + summary 필드 위주
  let data: {
    sessionId?: string;
    lastUpdated?: string;
    summary?: string;
    messages?: { type?: string; content?: unknown; timestamp?: string }[];
    projectHash?: string;
  };
  try {
    // 목록용: 전체가 필요하면 파싱하되, 실패 시 null
    data = JSON.parse(readFileSync(candidate.path, "utf-8"));
  } catch {
    return null;
  }

  const sessionId = data.sessionId ?? basename(candidate.path).replace(/^session-|\.json$/g, "");
  const roots = loadProjectRoots();
  const slug = candidate.hints?.projectSlug ?? basename(dirname(dirname(candidate.path)));
  const projectPath = roots.get(slug) ?? `(gemini:${slug})`;

  let title = typeof data.summary === "string" ? data.summary : "";
  if (!title && Array.isArray(data.messages)) {
    for (const m of data.messages.slice(0, 20)) {
      if (m.type !== "user" && m.type !== "gemini") continue;
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text ?? ""))
                .join(" ")
            : "";
      if (text.trim().length >= MIN_TITLE_CHARS) {
        title = text.trim();
        break;
      }
      if (!title && text.trim()) title = text.trim();
    }
  }

  const updatedAt = data.lastUpdated ? Date.parse(data.lastUpdated) || candidate.mtimeMs : candidate.mtimeMs;

  return {
    tool: "gemini",
    sessionId,
    projectPath,
    title: cleanTitle(title) || "(empty)",
    snippet: cleanTitle(title).slice(0, 200) || "",
    path: candidate.path,
    mtimeMs: candidate.mtimeMs,
    size: candidate.size,
    updatedAt,
    raw: { file: candidate.path, projectSlug: slug },
  };
}

async function read(meta: SessionMeta): Promise<Turn[]> {
  const file = (meta.raw?.file as string) ?? meta.path;
  let data: { messages?: { type?: string; content?: unknown }[] };
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
  const turns: Turn[] = [];
  for (const m of data.messages ?? []) {
    const role = m.type === "user" ? "user" : m.type === "gemini" || m.type === "model" ? "assistant" : null;
    if (!role) continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .map((c) => {
          if (typeof c === "string") return c;
          if (c && typeof c === "object" && "text" in c) return String((c as { text?: string }).text ?? "");
          return "";
        })
        .join("\n");
    }
    text = text.trim();
    if (text) turns.push({ role, text });
  }
  return turns;
}

async function write(turns: Turn[], projectPath: string): Promise<string> {
  // Gemini CLI checkpoint 포맷으로 저장 — resume 호환은 환경에 따라 다를 수 있음
  const newId = randomUUID();
  const slug = projectPath.split("/").filter(Boolean).pop() ?? "project";
  const chatsDir = join(TMP_DIR, slug, "chats");
  mkdirSync(chatsDir, { recursive: true });
  const now = new Date();
  const fname = `session-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${newId.slice(0, 8)}.json`;
  const outPath = join(chatsDir, fname);

  const messages = turns.map((t, i) => ({
    id: randomUUID(),
    timestamp: new Date(now.getTime() + i * 1000).toISOString(),
    type: t.role === "user" ? "user" : "gemini",
    content: t.text,
  }));

  const payload = {
    sessionId: newId,
    projectHash: slug,
    startTime: now.toISOString(),
    lastUpdated: now.toISOString(),
    messages,
    kind: "main",
    summary: (turns.find((t) => t.role === "user")?.text ?? "handoff").slice(0, 80),
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));

  // project_root 기록 (없으면)
  const histDir = join(HISTORY_DIR, slug);
  mkdirSync(histDir, { recursive: true });
  const pr = join(histDir, ".project_root");
  if (!existsSync(pr)) writeFileSync(pr, projectPath);

  return newId;
}

function resumeCmd(sessionId: string, _projectPath: string): string[] {
  // Gemini CLI: /chat resume 또는 --resume (버전에 따라 상이)
  return ["gemini", "--resume", sessionId];
}

export const geminiAdapter: Adapter = {
  tool: "gemini",
  scanCandidates,
  extractMeta,
  read,
  write,
  resumeCmd,
};
