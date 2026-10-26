/** Remove only an unambiguous presentation wrapper; callers still validate every field and source. */
export function parseShiyingModelJson(raw: string): unknown {
  const text = raw.trim();
  try { return JSON.parse(text) as unknown; } catch { /* A model may wrap its JSON for display. */ }
  const prose = (value: string) => !/[{}\[\]]|```/u.test(value);
  const firstFence = text.indexOf('```'), lastFence = text.lastIndexOf('```');
  if (firstFence >= 0) {
    if (lastFence === firstFence || !prose(text.slice(0, firstFence)) || !prose(text.slice(lastFence + 3))) {
      throw new Error('shiying_model_json_invalid');
    }
    const fenced = text.slice(firstFence, lastFence + 3).match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
    if (!fenced) throw new Error('shiying_model_json_invalid');
    return JSON.parse(fenced[1]) as unknown;
  }
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start || !prose(text.slice(0, start)) || !prose(text.slice(end + 1))) {
    throw new Error('shiying_model_json_invalid');
  }
  // Multiple objects, trailing commas and broken strings still fail JSON.parse.
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}
