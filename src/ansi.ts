export const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  brightWhite: "\x1b[97m",
  accent: "\x1b[94m",
} as const;

export type ColorName =
  "green" | "yellow" | "red" | "brightWhite" | "dim" | "accent";

export function paint(
  text: string,
  color: ColorName,
  enabled: boolean,
): string {
  if (!enabled) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

// Strip SGR escape sequences (ESC [ … m) so column padding measures the printed
// width, not the painted-string length — ANSI codes are non-printing. The ESC
// byte is built via fromCharCode rather than written as a literal in the regex,
// which would trip the no-control-regex lint.
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export function visibleLength(text: string): number {
  return text.replace(SGR, "").length;
}

// Right-pad a (possibly painted) string to a target visible width.
export function padVisible(text: string, width: number): string {
  const pad = width - visibleLength(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}
