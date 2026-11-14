// Detects the end of the top-level JSON object/array in a streamed text.
//
// Grammar-constrained (structured) outputs may keep emitting whitespace after the closing brace
// until num_predict is exhausted - sometimes for minutes. Watching the stream lets us stop the
// generation the moment the JSON value is complete.

export function createJsonEndDetector() {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  let done = false;

  return {
    get done() {
      return done;
    },
    /**
     * Feeds the next chunk.
     * @returns {number} how many characters of `chunk` belong to the JSON value once it is complete,
     *                   or -1 while it is still incomplete.
     */
    push(chunk) {
      if (done) return 0;
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === '"') {
          inString = true;
        } else if (c === '{' || c === '[') {
          depth++;
          started = true;
        } else if ((c === '}' || c === ']') && started) {
          depth--;
          if (depth === 0) {
            done = true;
            return i + 1;
          }
        }
      }
      return -1;
    },
  };
}

/** Parses JSON, tolerating a Markdown code fence around it. Returns undefined when invalid. */
export function parseJsonLoose(text) {
  const trimmed = String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
