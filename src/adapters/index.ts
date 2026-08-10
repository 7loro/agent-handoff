import type { Adapter, ToolName } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { grokAdapter } from "./grok.js";
import { geminiAdapter } from "./gemini.js";

export const ADAPTERS: Record<ToolName, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
  gemini: geminiAdapter,
};

export const TOOL_NAMES = Object.keys(ADAPTERS) as ToolName[];
