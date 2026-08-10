/**
 * 터미널 표시 폭 유틸.
 * JS string.length 는 한글/이모지를 1로 세지만, 터미널에서는 보통 2칸 →
 * 잘못된 clip/pad 가 줄바꿈을 만들고 레이아웃·색이 한꺼번에 깨진다.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** 단일 코드포인트의 터미널 칸 수 (대략적 East Asian Width) */
export function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  // 제어 문자
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // 이모지 등 (대략)
  if (cp >= 0x1f300 && cp <= 0x1faff) return 2;
  if (cp >= 0x1f600 && cp <= 0x1f64f) return 2;
  // 전각/CJK
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** plain 텍스트 표시 폭 */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += codePointWidth(ch.codePointAt(0)!);
  }
  return w;
}

/** ANSI 포함 문자열의 표시 폭 (시퀀스 제외) */
export function displayWidthAnsi(text: string): number {
  return displayWidth(stripAnsi(text));
}

/** plain 을 maxCols 칸으로 자르고 필요 시 … */
export function truncatePlain(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (displayWidth(text) <= maxCols) return text;
  if (maxCols === 1) return "…";
  let w = 0;
  let out = "";
  for (const ch of text) {
    const cw = codePointWidth(ch.codePointAt(0)!);
    if (w + cw > maxCols - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** plain 을 정확히 cols 칸으로 (부족하면 스페이스 패딩) */
export function padPlain(text: string, cols: number): string {
  const t = truncatePlain(text, cols);
  const w = displayWidth(t);
  if (w >= cols) return t;
  return t + " ".repeat(cols - w);
}

/**
 * ANSI 포함 문자열을 maxCols 칸으로 자름.
 * 시퀀스는 유지하되, plain 폭 기준으로 절단. 절단 후 reset 삽입.
 */
export function clipAnsi(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (displayWidthAnsi(text) <= maxCols) return text;

  let w = 0;
  let out = "";
  let i = 0;
  const limit = maxCols - 1; // room for …
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = codePointWidth(cp);
    if (w + cw > limit) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + "\x1b[0m…";
}
