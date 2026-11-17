// The step both graders share: find the answer object in an agent's reply. Everything
// after this (how a field is judged) is separate in grade-keyword.mjs and grade-values.mjs.

/** The outermost JSON object in a reply, even with prose or other braces around it. */
export function findObject(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
      try {
        const value = JSON.parse(text.slice(start, end + 1));
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      } catch {
        // Try a shorter span.
      }
    }
  }
  return {};
}

/** A field's value as text, or '' when it is absent or null. Arrays are joined, objects become JSON. */
export function fieldText(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(fieldText).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Grade a whole reply with one grader: { key: (text) => boolean }. Returns the score,
 * the total and a boolean per key; never the answer text itself.
 */
export function gradeReply(reply, grader) {
  const answer = findObject(String(reply ?? ''));
  const results = Object.fromEntries(Object.entries(grader).map(([key, check]) => {
    const text = fieldText(answer[key]).trim();
    return [key, text !== '' && check(text)];
  }));
  return { score: Object.values(results).filter(Boolean).length, total: Object.keys(grader).length, results };
}
