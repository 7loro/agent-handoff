import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionMeta, ToolName } from "./types.js";

const CACHE_DIR = join(homedir(), ".cache", "ahandoff");
const STORE_PATH = join(CACHE_DIR, "meta-v1.json");

interface StoreFile {
  version: 1;
  sessions: Record<string, SessionMeta>;
}

function keyOf(tool: ToolName, path: string): string {
  return `${tool}:${path}`;
}

function load(): StoreFile {
  try {
    if (!existsSync(STORE_PATH)) return { version: 1, sessions: {} };
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf-8")) as StoreFile;
    if (raw?.version !== 1 || typeof raw.sessions !== "object") {
      return { version: 1, sessions: {} };
    }
    return raw;
  } catch {
    return { version: 1, sessions: {} };
  }
}

function save(store: StoreFile): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store));
}

export class MetaStore {
  private store: StoreFile;
  private dirty = false;

  constructor() {
    this.store = load();
  }

  get(tool: ToolName, path: string, mtimeMs: number, size: number): SessionMeta | null {
    const hit = this.store.sessions[keyOf(tool, path)];
    if (!hit) return null;
    if (hit.mtimeMs !== mtimeMs || hit.size !== size) return null;
    return hit;
  }

  set(meta: SessionMeta): void {
    this.store.sessions[keyOf(meta.tool, meta.path)] = meta;
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    save(this.store);
    this.dirty = false;
  }
}
