import { paint } from "./ansi.js";
export const BAR_WIDTH = 8;
export const FILLED = "▓";
export const EMPTY = "░";
export const MARKER = "│";
export const FIVE_HOUR_SECONDS = 5 * 60 * 60;
export const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
// Fraction of the limit window already elapsed: 0 at window start, 1 at reset.
// resetsAt is Unix epoch seconds (the payload's unit); now is a Date.
export function elapsedFraction(resetsAt, windowSeconds, now) {
    const remainingSeconds = resetsAt - now.getTime() / 1000;
    return clamp(1 - remainingSeconds / windowSeconds, 0, 1);
}
// One flat colour rule for every bar: cell colour is the absolute used %, not
// pace and not a per-bar threshold. Green ≤ 50, yellow 51–70, red > 70 (board
// section 2, user-validated). Shared by the context bar and the 5h/7d bars.
export function fillColor(usedPercentage) {
    const used = clamp(usedPercentage, 0, 100);
    if (used <= 50)
        return "green";
    if (used <= 70)
        return "yellow";
    return "red";
}
// The marker sits at the even-pace position as a non-colour ahead/behind-pace
// hint; it no longer drives any cell's colour (colour is the flat % rule). The
// marker is drawn between cells, so the loop runs one extra step to place it at
// markerSlot ∈ [0, BAR_WIDTH].
export function paceBar(usedPercentage, paceFraction, color) {
    const used = clamp(usedPercentage, 0, 100);
    const fill = Math.round((used / 100) * BAR_WIDTH);
    const markerSlot = clamp(Math.round(paceFraction * BAR_WIDTH), 0, BAR_WIDTH);
    const cellColor = fillColor(used);
    let out = "";
    for (let i = 0; i <= BAR_WIDTH; i++) {
        if (i === markerSlot)
            out += paint(MARKER, "brightWhite", color);
        if (i === BAR_WIDTH)
            break;
        out +=
            i < fill ? paint(FILLED, cellColor, color) : paint(EMPTY, "dim", color);
    }
    return out;
}
export function contextBar(usedPercentage, color) {
    const used = clamp(usedPercentage, 0, 100);
    const fill = Math.round((used / 100) * BAR_WIDTH);
    const cellColor = fillColor(used);
    let out = "";
    for (let i = 0; i < BAR_WIDTH; i++) {
        out +=
            i < fill ? paint(FILLED, cellColor, color) : paint(EMPTY, "dim", color);
    }
    return out;
}
export function formatCountdown(secondsUntil) {
    if (secondsUntil <= 0)
        return "now";
    const totalMinutes = Math.floor(secondsUntil / 60);
    if (totalMinutes < 60)
        return `${totalMinutes}m`;
    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) {
        const minutes = totalMinutes % 60;
        return `${totalHours}h${String(minutes).padStart(2, "0")}m`;
    }
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return `${days}d${hours}h`;
}
