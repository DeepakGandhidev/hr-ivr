/**
 * cv_parsed is free-form jsonb written by the CV parser (§5 Stage 4), not a
 * validated shape. Real CVs make `skills`, `education` and `employers` come
 * back as an array on one document, a single string on the next, and missing
 * on a third.
 *
 * Calling .join() on that directly throws, and both call sites that do it run
 * on the critical path: the interviewer's system prompt (every turn of a live
 * call) and the post-call assessment. A candidate whose education parsed as a
 * string would have lost the whole interview to a TypeError.
 */
export function cvList(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map(cvScalar).filter(Boolean);
  }
  const single = cvScalar(value);
  return single ? [single] : [];
}

function cvScalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // An object entry (e.g. {degree, institution, year}) is worth keeping, but
  // only as something a model can read aloud.
  if (typeof value === 'object') {
    const parts = Object.values(value)
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.join(' ');
  }
  return '';
}
