import { mkdirSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Adapter, SessionCandidate, SessionMeta, Turn, ToolCallRecord, Attachment } from "../types.js";
import {
  findFilesSince,
  readJsonlLines,
  readJsonlLinesLazy,
  cleanTitle,
  truncate,
  MAX_TOOL_OUTPUT_CHARS,
  MIN_TITLE_CHARS,
} from "../util.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

function claudeCliVersion(): string {
  try {
    const out = execFileSync("claude", ["--version"], { encoding: "utf-8" });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1]! : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function encodeDir(cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // keep
  }
  return real.replace(/[^a-zA-Z0-9]/g, "-");
}

async function scanCandidates(sinceMs: number): Promise<SessionCandidate[]> {
  if (!existsSync(PROJECTS_DIR)) return [];
  return findFilesSince(PROJECTS_DIR, (p) => p.endsWith(".jsonl"), sinceMs).map((f) => ({
    tool: "claude" as const,
    path: f.path,
    mtimeMs: f.mtimeMs,
    size: f.size,
  }));
}

async function extractMeta(candidate: SessionCandidate): Promise<SessionMeta | null> {
  let cwd: string | undefined;
  let firstUserText = "";
  let titleText = "";
  let lines = 0;
  const MAX_LINES = 80; // 목록용 — 앞부분만

  for await (const obj of readJsonlLinesLazy(candidate.path)) {
    lines++;
    if (typeof obj.cwd === "string") cwd = obj.cwd;
    if (obj.type !== "user" && obj.type !== "assistant") {
      if (lines >= MAX_LINES && cwd && titleText) break;
      continue;
    }
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    let text = "";
    if (typeof message?.content === "string") {
      text = message.content;
    } else if (Array.isArray(message?.content)) {
      text = message.content
        .filter(
          (b): b is { type: string; text: string } =>
            typeof b === "object" && b !== null && (b as { type?: string }).type === "text"
        )
        .map((b) => b.text)
        .join(" ");
    }
    if (text && obj.type === "user") {
      if (!firstUserText) firstUserText = text;
      if (!titleText && text.length >= MIN_TITLE_CHARS) titleText = text;
    }
    if (cwd && titleText) break;
    if (lines >= MAX_LINES) break;
  }

  if (!cwd) return null;
  const sessionId = candidate.path.split("/").pop()!.replace(/\.jsonl$/, "");
  const title = cleanTitle(titleText || firstUserText) || "(empty)";
  return {
    tool: "claude",
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

async function read(meta: SessionMeta): Promise<Turn[]> {
  const file = (meta.raw?.file as string) ?? meta.path;
  const lines = readJsonlLines(file);
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
  const ensureRole = (role: "user" | "assistant") => {
    if (lastRole !== null && lastRole !== role) {
      if (lastRole === "user") flushUser();
      else flushAssistant();
    }
    lastRole = role;
  };

  const extractAttachmentBlock = (b: Record<string, unknown>): Attachment | null => {
    const src = b.source as { type?: string; media_type?: string; data?: string } | undefined;
    if (src?.type === "base64" && typeof src.data === "string") {
      return { mimeType: src.media_type ?? "application/octet-stream", base64: src.data };
    }
    return null;
  };

  for (const obj of lines) {
    if (obj.type === "attachment") {
      const att = obj.attachment as {
        type?: string;
        filename?: string;
        content?: { type?: string; file?: { content?: string; base64?: string } };
      } | undefined;
      if (att?.type === "file") {
        ensureRole("user");
        const filename = att.filename ?? "unnamed";
        if (att.content?.type === "text" && typeof att.content.file?.content === "string") {
          userTextParts.push(`<file name="${filename}">\n${att.content.file.content}\n</file>`);
        } else if (typeof att.content?.file?.base64 === "string") {
          const mime = att.content.type === "pdf" ? "application/pdf" : "application/octet-stream";
          userAttachments.push({ mimeType: mime, base64: att.content.file.base64, filename });
        }
      }
      continue;
    }

    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = message?.content;

    if (role === "assistant") {
      ensureRole("assistant");
      if (typeof content === "string") {
        if (content.trim()) assistantTextParts.push(content.trim());
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          const block = b as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") {
            const t = block.text.trim();
            if (t) assistantTextParts.push(t);
          } else if (block.type === "tool_use") {
            const rec: ToolCallRecord = {
              name: typeof block.name === "string" ? block.name : "unknown_tool",
              input: JSON.stringify(block.input ?? {}),
            };
            pendingToolCalls.push(rec);
            if (typeof block.id === "string") callIndex.set(block.id, rec);
          } else if (block.type === "image" || block.type === "document") {
            const att = extractAttachmentBlock(block);
            if (att) pendingAttachments.push(att);
          }
        }
      }
      continue;
    }

    let hadToolResult = false;
    const localText: string[] = [];
    const localAttachments: Attachment[] = [];
    if (typeof content === "string") {
      if (content.trim()) localText.push(content.trim());
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        const block = b as Record<string, unknown>;
        if (block.type === "tool_result") {
          hadToolResult = true;
          const id = block.tool_use_id;
          const rec = typeof id === "string" ? callIndex.get(id) : undefined;
          if (rec) {
            const out = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
            rec.output = truncate(out, MAX_TOOL_OUTPUT_CHARS);
          }
        } else if (block.type === "text" && typeof block.text === "string") {
          const t = block.text.trim();
          if (t) localText.push(t);
        } else if (block.type === "image" || block.type === "document") {
          const att = extractAttachmentBlock(block);
          if (att) localAttachments.push(att);
        }
      }
    }
    if (hadToolResult && localText.length === 0 && localAttachments.length === 0) continue;

    ensureRole("user");
    userTextParts.push(...localText);
    userAttachments.push(...localAttachments);
  }
  flushUser();
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
  const cliVersion = claudeCliVersion();
  const encoded = encodeDir(realCwd);
  const sessionDir = join(PROJECTS_DIR, encoded);
  mkdirSync(sessionDir, { recursive: true });

  const newId = randomUUID();
  const outPath = join(sessionDir, `${newId}.jsonl`);
  const lines: string[] = [];
  let parentUuid: string | null = null;
  let lastUuid: string | null = null;

  for (const turn of turns) {
    const myUuid = randomUUID();
    const ts = new Date().toISOString();
    const attachments = turn.attachments ?? [];
    const otherNote = attachments
      .filter((a) => !a.mimeType.startsWith("image/") && a.mimeType !== "application/pdf")
      .map((a) => `[attached file: ${a.filename ?? "unnamed"} (${a.mimeType})]`)
      .join("\n");
    const combinedText = [turn.text, otherNote].filter(Boolean).join("\n\n");
    const attachmentBlocks = attachments
      .filter((a) => a.mimeType.startsWith("image/") || a.mimeType === "application/pdf")
      .map((a) => ({
        type: a.mimeType === "application/pdf" ? "document" : "image",
        source: { type: "base64", media_type: a.mimeType, data: a.base64 },
      }));

    if (turn.role === "user") {
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          promptId: randomUUID(),
          type: "user",
          message: {
            role: "user",
            content: attachmentBlocks.length
              ? [...attachmentBlocks, ...(combinedText ? [{ type: "text", text: combinedText }] : [])]
              : combinedText,
          },
          uuid: myUuid,
          timestamp: ts,
          userType: "external",
          entrypoint: "cli",
          cwd: realCwd,
          sessionId: newId,
          version: cliVersion,
        })
      );
      parentUuid = myUuid;
      lastUuid = myUuid;
      continue;
    }

    const toolCalls = turn.toolCalls ?? [];
    const toolUseIds = toolCalls.map(() => `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`);
    const toolUseBlocks = toolCalls.map((tc, i) => {
      let input: unknown = tc.input;
      try {
        input = JSON.parse(tc.input);
      } catch {
        // keep string
      }
      return { type: "tool_use", id: toolUseIds[i], name: tc.name, input };
    });
    lines.push(
      JSON.stringify({
        parentUuid,
        isSidechain: false,
        message: {
          model: "claude-sonnet-5",
          id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "message",
          role: "assistant",
          content: [
            ...attachmentBlocks,
            ...(combinedText ? [{ type: "text", text: combinedText }] : []),
            ...toolUseBlocks,
          ],
          stop_reason: toolCalls.length ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        type: "assistant",
        uuid: myUuid,
        timestamp: ts,
        userType: "external",
        entrypoint: "cli",
        cwd: realCwd,
        sessionId: newId,
        version: cliVersion,
      })
    );
    parentUuid = myUuid;
    lastUuid = myUuid;

    if (toolCalls.length) {
      const resultUuid = randomUUID();
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          promptId: randomUUID(),
          type: "user",
          message: {
            role: "user",
            content: toolCalls.map((tc, i) => ({
              type: "tool_result",
              tool_use_id: toolUseIds[i],
              content: tc.output ?? "",
            })),
          },
          uuid: resultUuid,
          timestamp: new Date().toISOString(),
          userType: "external",
          entrypoint: "cli",
          cwd: realCwd,
          sessionId: newId,
          version: cliVersion,
        })
      );
      parentUuid = resultUuid;
      lastUuid = resultUuid;
    }
  }

  lines.unshift(JSON.stringify({ type: "last-prompt", leafUuid: lastUuid, sessionId: newId }));
  writeFileSync(outPath, lines.join("\n") + "\n");
  return newId;
}

function resumeCmd(sessionId: string, _projectPath: string): string[] {
  return ["claude", "--resume", sessionId];
}

export const claudeAdapter: Adapter = {
  tool: "claude",
  scanCandidates,
  extractMeta,
  read,
  write,
  resumeCmd,
};
