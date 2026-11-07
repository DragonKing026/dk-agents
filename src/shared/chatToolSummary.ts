const MAX_SUMMARY_CHARS = 90;

/** Input fields that identify "what the tool works on", in order of preference. */
const SUMMARY_FIELDS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'prompt'] as const;

/** One-line gist of a tool's input for a collapsed tool card (path, command, pattern...). Empty when unknown. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') return clip(input);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  const obj = input as Record<string, unknown>;
  for (const key of SUMMARY_FIELDS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim().length > 0) return clip(v);
  }
  return '';
}

function clip(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_SUMMARY_CHARS ? `${oneLine.slice(0, MAX_SUMMARY_CHARS - 1)}…` : oneLine;
}

/** Pretty JSON of a tool input for the expanded card (never throws). */
export function formatToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}, null, 2) ?? '';
  } catch {
    return String(input);
  }
}
