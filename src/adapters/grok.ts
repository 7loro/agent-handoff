import { mkdirSync, writeFileSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Adapter, SessionCandidate, SessionMeta, Turn, ToolCallRecord, Attachment } from "../types.js";
import {
  findFilesSince,
  readJsonlLines,
  cleanTitle,
  truncate,
  MAX_TOOL_OUTPUT_CHARS,
} from "../util.js";

const SESSIONS_DIR = join(homedir(), ".grok", "sessions");

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}

function extractUserQuery(text: string): string | null {
  const start = text.indexOf("<user_query>");
  const end = text.indexOf("</user_query>");
  if (start === -1 || end === -1) return null;
  return text.slice(start + "<user_query>".length, end).trim();
}

async function scanCandidates(sinceMs: number): Promise<SessionCandidate[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  // summary.json 만 스캔 — chat 본문은 hop 시
  return findFilesSince(SESSIONS_DIR, (p) => p.endsWith("summary.json"), sinceMs, 6).map((f) => ({
    tool: "grok" as const,
    path: f.path,
    mtimeMs: f.mtimeMs,
    size: f.size,
  }));
}

async function extractMeta(candidate: SessionCandidate): Promise<SessionMeta | null> {
  let summary: Record<string, unknown>;
  try {
    summary = JSON.parse(readFileSync(candidate.path, "utf-8"));
  } catch {
    return null;
  }
  const info = summary.info as { id?: string; cwd?: string } | undefined;
  const sessionId = info?.id;
  const cwd = info?.cwd;
  if (!sessionId || !cwd) return null;

  const sessionDir = candidate.path.replace(/\/summary\.json$/, "");
  const chatFile = join(sessionDir, "chat_history.jsonl");
  const title =
    cleanTitle((summary.generated_title as string) || (summary.session_summary as string) || "") ||
    "(empty)";

  // chat mtime이 더 최근일 수 있음
  let updatedAt = candidate.mtimeMs;
  let chatSize = candidate.size;
  try {
    const { statSync } = await import("node:fs");
    const st = statSync(chatFile);
    updatedAt = Math.max(updatedAt, st.mtimeMs);
    chatSize = st.size;
  } catch {
    // no chat file
  }

  return {
    tool: "grok",
    sessionId,
    projectPath: cwd,
    title,
    snippet: title.slice(0, 200),
    path: chatFile,
    mtimeMs: updatedAt,
    size: chatSize,
    updatedAt,
    raw: { file: chatFile, summaryFile: candidate.path },
  };
}

async function read(meta: SessionMeta): Promise<Turn[]> {
  const chatFile = (meta.raw?.file as string) ?? meta.path;
  const updatesFile = chatFile.replace(/chat_history\.jsonl$/, "updates.jsonl");
  const lines = readJsonlLines(updatesFile);
  const turns: Turn[] = [];

  let userTextParts: string[] = [];
  let userAttachments: Attachment[] = [];
  let assistantTextParts: string[] = [];
  let pendingToolCalls: ToolCallRecord[] = [];
  let pendingAttachments: Attachment[] = [];
  const callIndex = new Map<string, ToolCallRecord>();
  let lastRole: "user" | "assistant" | null = null;

  const flushUser = () => {
    const text = userTextParts.join("\n\n").trim();
    if (text || userAttachments.length) {
      turns.push({
        role: "user",
        text,
        attachments: userAttachments.length ? userAttachments : undefined,
      });
    }
    userTextParts = [];
    userAttachments = [];
  };
  const flushAssistant = () => {
    const text = assistantTextParts.join("").trim();
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
  const ensureRole = (role: "user" | "assistant") => {
    if (lastRole !== null && lastRole !== role) {
      if (lastRole === "user") flushUser();
      else flushAssistant();
    }
    lastRole = role;
  };

  for (const obj of lines) {
    const params = obj.params as { update?: Record<string, unknown> } | undefined;
    const update = params?.update;
    if (!update) continue;
    const kind = update.sessionUpdate;

    if (kind === "user_message_chunk") {
      ensureRole("user");
      const content = update.content as {
        type?: string;
        text?: string;
        data?: string;
        mimeType?: string;
      } | undefined;
      if (content?.type === "image" && typeof content.data === "string") {
        userAttachments.push({ mimeType: content.mimeType ?? "image/png", base64: content.data });
      } else if (typeof content?.text === "string" && content.text.trim()) {
        userTextParts.push(content.text.trim());
      }
      continue;
    }
    if (kind === "agent_message_chunk") {
      ensureRole("assistant");
      const text = (update.content as { text?: string } | undefined)?.text ?? "";
      if (text) assistantTextParts.push(text);
      continue;
    }
    if (kind === "tool_call") {
      ensureRole("assistant");
      const metaTool = (update._meta as Record<string, unknown> | undefined)?.["x.ai/tool"] as
        | { name?: string }
        | undefined;
      const name = metaTool?.name ?? (typeof update.title === "string" ? update.title : "unknown_tool");
      const rec: ToolCallRecord = { name, input: JSON.stringify(update.rawInput ?? {}) };
      pendingToolCalls.push(rec);
      if (typeof update.toolCallId === "string") callIndex.set(update.toolCallId, rec);
      continue;
    }
    if (kind === "tool_call_update") {
      const rec = typeof update.toolCallId === "string" ? callIndex.get(update.toolCallId) : undefined;
      if (!rec) continue;
      let out = "";
      if (Array.isArray(update.content)) {
        const items = update.content as {
          type?: string;
          content?: { type?: string; text?: string; data?: string; mimeType?: string };
        }[];
        out = items
          .map((c) => c.content?.text ?? "")
          .filter(Boolean)
          .join("\n");
        for (const c of items) {
          if (c.content?.type === "image" && typeof c.content.data === "string") {
            pendingAttachments.push({
              mimeType: c.content.mimeType ?? "image/png",
              base64: c.content.data,
            });
          }
        }
      }
      if (!out && update.rawOutput !== undefined) out = JSON.stringify(update.rawOutput);
      if (out) rec.output = truncate(out, MAX_TOOL_OUTPUT_CHARS);
      continue;
    }
  }
  flushUser();
  flushAssistant();

  // updates 없으면 chat_history 폴백
  if (turns.length === 0 && existsSync(chatFile)) {
    for (const obj of readJsonlLines(chatFile)) {
      if (obj.type === "user" && Array.isArray(obj.content)) {
        for (const b of obj.content as { text?: string }[]) {
          const q = extractUserQuery(b.text ?? "");
          if (q) turns.push({ role: "user", text: q });
        }
      } else if (obj.type === "assistant" && typeof obj.content === "string" && obj.content.trim()) {
        turns.push({ role: "assistant", text: obj.content.trim() });
      }
    }
  }
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
  const encodedCwd = encodeURIComponent(realCwd);
  const newId = randomUUID();
  const sessionDir = join(SESSIONS_DIR, encodedCwd, newId);
  mkdirSync(sessionDir, { recursive: true });
  const now = new Date();

  const lines: string[] = [
    JSON.stringify({
      type: "system",
      content: "You are Grok, an interactive CLI tool that helps users with software engineering tasks.",
    }),
    JSON.stringify({
      type: "user",
      content: [
        {
          type: "text",
          text: `<user_info>\nOS Version: macos\nShell: /bin/zsh\nWorkspace Path: ${realCwd}\nToday's date: ${now.toISOString().slice(0, 10)}\n</user_info>`,
        },
      ],
    }),
  ];

  let promptIdx = 0;
  for (const turn of turns) {
    if (turn.role === "user") {
      const imageBlocks = (turn.attachments ?? [])
        .filter((a) => a.mimeType.startsWith("image/"))
        .map((img) => ({ type: "image", url: `data:${img.mimeType};base64,${img.base64}` }));
      const nonImageNote = (turn.attachments ?? [])
        .filter((a) => !a.mimeType.startsWith("image/"))
        .map((a) => `[attached file: ${a.filename ?? "unnamed"} (${a.mimeType})]`)
        .join("\n");
      const queryText = [turn.text, nonImageNote].filter(Boolean).join("\n\n");
      lines.push(
        JSON.stringify({
          type: "user",
          content: [{ type: "text", text: `<user_query>\n${queryText}\n</user_query>` }, ...imageBlocks],
          prompt_index: promptIdx,
        })
      );
      promptIdx++;
    } else {
      const realToolCalls = (turn.toolCalls ?? []).map((tc) => ({
        id: `call-${randomUUID()}-0`,
        name: tc.name,
        arguments: tc.input,
      }));
      const nonImageNote = (turn.attachments ?? [])
        .filter((a) => !a.mimeType.startsWith("image/"))
        .map((a) => `[attached file: ${a.filename ?? "unnamed"} (${a.mimeType})]`)
        .join("\n");
      lines.push(
        JSON.stringify({
          type: "assistant",
          content: [turn.text, nonImageNote].filter(Boolean).join("\n\n"),
          model_id: "grok-4.5-build",
          model_fingerprint: "fp_handoff",
          reasoning_effort: "low",
          ...(realToolCalls.length ? { tool_calls: realToolCalls } : {}),
        })
      );
      (turn.toolCalls ?? []).forEach((tc, i) => {
        lines.push(
          JSON.stringify({
            type: "tool_result",
            tool_call_id: realToolCalls[i]!.id,
            content: tc.output ?? "",
          })
        );
      });
    }
  }
  writeFileSync(join(sessionDir, "chat_history.jsonl"), lines.join("\n") + "\n");

  const sessionStartSec = Math.floor(now.getTime() / 1000);
  const updates: string[] = [];
  let updatePromptIdx = 0;
  turns.forEach((turn, i) => {
    const eventNum = i + 1;
    const ts = sessionStartSec + i;
    if (turn.role === "user") {
      updates.push(
        JSON.stringify({
          timestamp: ts,
          method: "session/update",
          params: {
            sessionId: newId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: turn.text },
              _meta: { modelId: "grok-4.5", promptIndex: updatePromptIdx },
            },
            _meta: { eventId: `${newId}-${eventNum}`, agentTimestampMs: ts * 1000 },
          },
        })
      );
      updatePromptIdx++;
    } else {
      for (const tc of turn.toolCalls ?? []) {
        const toolCallId = `call-${randomUUID()}-0`;
        updates.push(
          JSON.stringify({
            timestamp: ts,
            method: "session/update",
            params: {
              sessionId: newId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId,
                title: tc.name,
                rawInput: safeJsonParse(tc.input),
                _meta: {
                  "x.ai/tool": {
                    version: 1,
                    name: tc.name,
                    kind: "execute",
                    namespace: "grok_build",
                    label: tc.name,
                    read_only: false,
                  },
                },
              },
              _meta: { eventId: `${newId}-${eventNum}-tool`, agentTimestampMs: ts * 1000 },
            },
          })
        );
        updates.push(
          JSON.stringify({
            timestamp: ts,
            method: "session/update",
            params: {
              sessionId: newId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "completed",
                content: [{ type: "content", content: { type: "text", text: tc.output ?? "" } }],
                rawOutput: tc.output ?? "",
              },
              _meta: { eventId: `${newId}-${eventNum}-tool-done`, agentTimestampMs: ts * 1000 },
            },
          })
        );
      }
      updates.push(
        JSON.stringify({
          timestamp: ts,
          method: "session/update",
          params: {
            sessionId: newId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: turn.text },
            },
            _meta: {
              totalTokens: 0,
              eventId: `${newId}-${eventNum}`,
              agentTimestampMs: ts * 1000,
              promptId: newId,
              streamStartMs: ts * 1000,
              turnStartMs: ts * 1000,
              updateType: "AgentMessageChunk",
              chunkId: eventNum,
            },
          },
        })
      );
    }
  });
  writeFileSync(join(sessionDir, "updates.jsonl"), updates.join("\n") + "\n");

  const nowIso = now.toISOString();
  const realTitle = (turns.find((t) => t.role === "user")?.text ?? "Resumed via ahandoff").slice(0, 80);
  const summary = {
    info: { id: newId, cwd: realCwd },
    session_summary: realTitle,
    created_at: nowIso,
    updated_at: nowIso,
    num_messages: turns.length,
    num_chat_messages: lines.length,
    current_model_id: "grok-4.5",
    next_trace_turn: 1,
    chat_format_version: 1,
    request_id: randomUUID(),
    grok_home: join(homedir(), ".grok"),
    last_active_at: nowIso,
    generated_title: realTitle,
    agent_name: "grok-build-plan",
    sandbox_profile: "off",
    reasoning_effort: "low",
  };
  writeFileSync(join(sessionDir, "summary.json"), JSON.stringify(summary, null, 2));
  return newId;
}

function resumeCmd(sessionId: string, _projectPath: string): string[] {
  return ["grok", "--resume", sessionId];
}

export const grokAdapter: Adapter = {
  tool: "grok",
  scanCandidates,
  extractMeta,
  read,
  write,
  resumeCmd,
};
