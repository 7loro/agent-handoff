export type Role = "user" | "assistant";
export type ToolName = "claude" | "codex" | "grok" | "gemini";

export interface ToolCallRecord {
  name: string;
  input: string;
  output?: string;
}

export interface Attachment {
  mimeType: string;
  base64: string;
  filename?: string;
}

export interface Turn {
  role: Role;
  text: string;
  toolCalls?: ToolCallRecord[];
  attachments?: Attachment[];
}

/** 디스크 후보 — 내용 파싱 전 (stat only) */
export interface SessionCandidate {
  tool: ToolName;
  path: string;
  mtimeMs: number;
  size: number;
  /** 경로에서 바로 알 수 있으면 채움 (예: sessionId, project hint) */
  hints?: Record<string, string>;
}

/** 목록/검색용 메타 — 캐시 가능 */
export interface SessionMeta {
  tool: ToolName;
  sessionId: string;
  projectPath: string;
  title: string;
  snippet: string;
  path: string;
  mtimeMs: number;
  size: number;
  updatedAt: number;
  raw?: Record<string, unknown>;
}

export interface Adapter {
  tool: ToolName;
  /** mtime 필터 적용한 후보 열거 (본문 파싱 없음) */
  scanCandidates(sinceMs: number): Promise<SessionCandidate[]>;
  /** 후보 1건 → 최소 메타 추출 */
  extractMeta(candidate: SessionCandidate): Promise<SessionMeta | null>;
  read(meta: SessionMeta): Promise<Turn[]>;
  write(turns: Turn[], projectPath: string): Promise<string>;
  resumeCmd(sessionId: string, projectPath: string): string[];
}

export interface TimingPhases {
  scan_ms: number;
  extract_ms: number;
  store_ms: number;
  rank_ms: number;
}

export interface TimingReport {
  event: "list_ready";
  elapsed_ms: number;
  days: number;
  since: string;
  tools: ToolName[];
  project_cwd: string;
  counts: {
    candidates: number;
    parsed: number;
    cache_hit: number;
    cache_miss: number;
    sessions: number;
    cwd_sessions: number;
  };
  phases_ms: TimingPhases;
  per_tool_ms: Partial<Record<ToolName, number>>;
}
