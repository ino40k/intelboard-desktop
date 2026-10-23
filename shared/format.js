/** @typedef {{start:number,end:number,style:number}} FormatRange */
/** Canonical, non-overlapping UTF-16 ranges; only bold(1), italic(2), underline(4).
 * Text remains plain text; neither saved markup nor clipboard HTML is rendered.
 * @param {string} text @param {FormatRange[]} [ranges]
 * @returns {FormatRange[]}
 */
export function formatRuns(text, ranges = []) {
  const events = new Map([
    [0, [0, 0, 0]],
    [text.length, [0, 0, 0]],
  ]);
  for (const r of ranges) {
    const start = Math.max(0, Math.min(text.length, Math.trunc(r.start)));
    const end = Math.max(start, Math.min(text.length, Math.trunc(r.end)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) continue;
    for (const [at, delta] of [
      [start, 1],
      [end, -1],
    ]) {
      if (!events.has(at)) events.set(at, [0, 0, 0]);
      const value = events.get(at);
      [1, 2, 4].forEach((bit, i) => {
        if (r.style & bit) value[i] += delta;
      });
    }
  }
  const points = [...events.keys()].sort((a, b) => a - b),
    counts = [0, 0, 0];
  /** @type {FormatRange[]} */
  const result = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i],
      end = points[i + 1];
    events.get(start).forEach((v, j) => {
      counts[j] += v;
    });
    const style = counts.reduce((m, n, j) => (n > 0 ? m | (1 << j) : m), 0);
    if (end <= start) continue;
    const prev = result.at(-1);
    if (prev?.style === style) prev.end = end;
    else result.push({ start, end, style });
  }
  return result;
}
/** @param {string} text @param {FormatRange[]} ranges @param {number} start @param {number} end @param {number} bit */
export function toggleFormat(text, ranges, start, end, bit) {
  const runs = formatRuns(text, ranges);
  start = Math.max(0, Math.min(text.length, start));
  end = Math.max(start, Math.min(text.length, end));
  if (start === end) return runs.filter((r) => r.style);
  const clear = runs.filter((r) => r.start < end && r.end > start).every((r) => r.style & bit);
  const result = runs.flatMap((r) => {
    const cuts = [
      ...new Set([
        r.start,
        r.end,
        Math.max(r.start, Math.min(r.end, start)),
        Math.max(r.start, Math.min(r.end, end)),
      ]),
    ].sort((a, b) => a - b);
    return cuts.slice(0, -1).map((a, i) => ({
      start: a,
      end: cuts[i + 1],
      style: a >= start && a < end ? (clear ? r.style & ~bit : r.style | bit) : r.style,
    }));
  });
  return formatRuns(text, result).filter((r) => r.style);
}
/** Replace a selection while rebasing marks on both sides.
 * @param {string} text @param {FormatRange[]} ranges @param {number} start
 * @param {number} end @param {string} inserted @param {FormatRange[]} [insertedFormat]
 */
export function replaceText(text, ranges, start, end, inserted, insertedFormat) {
  const runs = formatRuns(text, ranges),
    delta = inserted.length - (end - start);
  const inherited =
    runs.find((r) => r.start <= start && start < r.end)?.style ?? runs.at(-1)?.style ?? 0;
  const next = runs.flatMap((r) => [
    ...(r.start < start ? [{ start: r.start, end: Math.min(r.end, start), style: r.style }] : []),
    ...(r.end > end
      ? [{ start: Math.max(r.start, end) + delta, end: r.end + delta, style: r.style }]
      : []),
  ]);
  for (const r of formatRuns(
    inserted,
    insertedFormat ?? [{ start: 0, end: inserted.length, style: inherited }],
  ))
    next.push({ start: start + r.start, end: start + r.end, style: r.style });
  const value = text.slice(0, start) + inserted + text.slice(end);
  return { text: value, format: formatRuns(value, next).filter((r) => r.style) };
}
