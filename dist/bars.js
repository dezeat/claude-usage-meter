import { paint } from "./ansi.js";
export const BAR_WIDTH = 6;
// The facelift's shorter bar (ADR-0007): a 3-cell meter reclaims width for the
// single-line HUD. The percentage beside it carries the precision the coarser
// bar gives up, so glance-magnitude survives at a quarter of the columns.
export const SHORT_BAR_WIDTH = 3;
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
export function paceBar(usedPercentage, paceFraction, color, width = BAR_WIDTH) {
    const used = clamp(usedPercentage, 0, 100);
    const fill = Math.round((used / 100) * width);
    const markerSlot = clamp(Math.round(paceFraction * width), 0, width);
    const cellColor = fillColor(used);
    let out = "";
    for (let i = 0; i <= width; i++) {
        if (i === markerSlot)
            out += paint(MARKER, "brightWhite", color);
        if (i === width)
            break;
        out +=
            i < fill ? paint(FILLED, cellColor, color) : paint(EMPTY, "dim", color);
    }
    return out;
}
export function contextBar(usedPercentage, color, width = BAR_WIDTH) {
    const used = clamp(usedPercentage, 0, 100);
    const fill = Math.round((used / 100) * width);
    const cellColor = fillColor(used);
    let out = "";
    for (let i = 0; i < width; i++) {
        out +=
            i < fill ? paint(FILLED, cellColor, color) : paint(EMPTY, "dim", color);
    }
    return out;
}
// Only the largest unit is displayed — "2d", not "2d3h" (maintainer rule: the
// glance needs the order of magnitude, not precision). Floored, so a unit only
// appears once at least one of it remains.
export function formatCountdown(secondsUntil) {
    if (secondsUntil < 1)
        return "now";
    const totalSeconds = Math.floor(secondsUntil);
    if (totalSeconds < 60)
        return `${totalSeconds}s`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60)
        return `${totalMinutes}m`;
    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24)
        return `${totalHours}h`;
    return `${Math.floor(totalHours / 24)}d`;
}
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
// The absolute wall-clock day a window resets, as `Dd DD.MM` ("Tu 16.06") —
// the human anchor a multi-day countdown lacks. resetsAt is Unix epoch seconds
// (the payload's unit). Components are read in the host's local timezone so the
// day matches the user's clock; the only input is the timestamp, so it stays
// pure and deterministic under a fixed timezone.
export function formatResetDate(resetsAtSeconds) {
    const d = new Date(resetsAtSeconds * 1000);
    const weekday = WEEKDAYS[d.getDay()] ?? "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${weekday} ${dd}.${mm}`;
}
