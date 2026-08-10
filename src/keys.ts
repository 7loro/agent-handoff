/**
 * 영문 자판이 아니어도 j/k 네비가 되게 — 같은 물리 키의 IME 출력 매핑.
 *
 * 터미널 raw 모드는 스캔코드가 아니라 "입력된 문자"만 받으므로,
 * 한글/일본어 자판 상태에서 해당 키가 만드는 문자를 alias 로 둔다.
 *
 * 한글 두벌식: j→ㅓ, k→ㅏ, g→ㅎ, G(shift+g 조합은 환경마다 다름), q→ㅂ
 * 전각 로마자: ｊｋ 등
 * 화살표 CSI 는 그대로 지원
 */

function norm(key: string): string {
  return key.normalize("NFC");
}

/** 아래 이동 (j / ↓ / 한글 ㅓ / 전각 ｊ …) */
export function isMoveDown(key: string): boolean {
  if (key === "\x1b[B") return true; // ↓
  const k = norm(key);
  // j, J, 전각 ｊ Ｊ
  if (k === "j" || k === "J" || k === "ｊ" || k === "Ｊ") return true;
  // 한글 두벌식 j 자리 → ㅓ (호환 자모 / 조합형 자모)
  if (k === "ㅓ" || k === "\u3153" || k === "\u1165") return true;
  // 일본어: 로마자 입력이면 j 그대로; 가나 배열에서 j 자리 근처 문자는 환경차 큼
  // 전각 소문자 ｊ 는 위에서 처리
  return false;
}

/** 위 이동 (k / ↑ / 한글 ㅏ / 전각 ｋ …) */
export function isMoveUp(key: string): boolean {
  if (key === "\x1b[A") return true; // ↑
  const k = norm(key);
  if (k === "k" || k === "K" || k === "ｋ" || k === "Ｋ") return true;
  // 한글 두벌식 k 자리 → ㅏ
  if (k === "ㅏ" || k === "\u314F" || k === "\u1161") return true;
  return false;
}

/** 맨 위 (g / Home / 한글 ㅎ) */
export function isGoTop(key: string): boolean {
  if (key === "\x1b[H" || key === "\x1b[1~") return true;
  const k = norm(key);
  if (k === "g" || k === "ｇ") return true;
  if (k === "ㅎ" || k === "\u314E" || k === "\u1112") return true;
  return false;
}

/** 맨 아래 (G / End) — shift+g 는 영문 모드에서만 확실한 경우가 많음 */
export function isGoBottom(key: string): boolean {
  if (key === "\x1b[F" || key === "\x1b[4~" || key === "\x1b[End") return true;
  const k = norm(key);
  return k === "G" || k === "Ｇ";
}

/** 종료 (q / 한글 ㅂ) — 검색 모드가 아닐 때만 호출할 것 */
export function isQuit(key: string): boolean {
  const k = norm(key);
  if (k === "q" || k === "Q" || k === "ｑ" || k === "Ｑ") return true;
  // 두벌식 q → ㅂ
  if (k === "ㅂ" || k === "\u3142" || k === "\u1107") return true;
  return false;
}
