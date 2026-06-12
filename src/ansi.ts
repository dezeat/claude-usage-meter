export const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  brightWhite: "\x1b[97m",
} as const;

export type ColorName = "green" | "yellow" | "red" | "brightWhite" | "dim";

export function paint(
  text: string,
  color: ColorName,
  enabled: boolean,
): string {
  if (!enabled) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}
