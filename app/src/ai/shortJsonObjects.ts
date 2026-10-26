export function readJsonObjects(text: string) {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!stripped) return [];
  try {
    const parsed = JSON.parse(stripped) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? [parsed] : [];
  } catch {
    // Continue with balanced-object extraction for responses that add a short wrapper.
  }

  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < stripped.length; index += 1) {
    const character = stripped[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    try {
      const parsed = JSON.parse(stripped.slice(start, index + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) objects.push(parsed);
    } catch {
      // Invalid candidates are ignored; exactly one valid object is required below.
    }
    start = -1;
  }
  return objects;
}
