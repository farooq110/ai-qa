/**
 * Shared before/after text diff: what an action made appear, disappear, or move to.
 * Used by the crawler (exercising a safe control at analysis time) and, later, the dry run
 * (checking a generated test's own action at execution time) - same question, same answer shape.
 */
export interface TextSnapshot { texts: string[]; url: string }
export interface TextDiff { appeared: string[]; disappeared: string[]; urlChanged?: string }

const MAX_DIFF_ITEMS = 20;
const norm = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Text that changes with the data rather than with the action, or is several elements run together:
 * bare numbers ("633"), a label glued to its count ("Pending1" - a space, as in "Room 12", is a real label), and camel
 * glue from adjacent cells ("Date & DayArea"). Asserting these is flaky or meaningless, so they never count as
 * evidence of what a control did. IDs like "ORD-2026-72B6-1" and ordinary words pass.
 */
export function isNoiseText(value: string): boolean {
  const text = value.trim();
  return /^[\d.,\s%+\-:/]+$/.test(text) || /^[A-Za-z][A-Za-z ]*[A-Za-z]\d+$/.test(text) || /[a-z\d][A-Z][a-z]/.test(text);
}

export function diffTextSnapshots(before: TextSnapshot, after: TextSnapshot): TextDiff {
  const beforeSeen = new Set(before.texts.map(norm));
  const afterSeen = new Set(after.texts.map(norm));
  const appeared = [...new Set(after.texts.filter((text) => !beforeSeen.has(norm(text)) && !isNoiseText(text)))].slice(0, MAX_DIFF_ITEMS);
  const disappeared = [...new Set(before.texts.filter((text) => !afterSeen.has(norm(text)) && !isNoiseText(text)))].slice(0, MAX_DIFF_ITEMS);
  return { appeared, disappeared, ...(before.url !== after.url ? { urlChanged: after.url } : {}) };
}
