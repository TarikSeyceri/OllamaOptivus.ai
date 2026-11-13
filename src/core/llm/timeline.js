// Turns an analysis (v2) into a compact, time-ordered timeline for the language model.
//
// - The whole video is covered: speech segments plus the gaps before, between and after them.
//   Long silent gaps are split at scene cuts and every MAX_GAP_SECONDS so visual changes keep their
//   timing. Every sampled frame belongs to exactly one window (half-open intervals).
// - OCR noise is reduced: fragments shorter than 3 letters/digits are dropped, near-duplicates are
//   merged ("OR, ISTANBUL" vs "CR, ISTANBUL"; numbers must match exactly), background text that is
//   visible most of the time is reported once, and windows only list text that is new.
// - Object detections must persist across at least two sampled frames (drops one-frame false
//   positives) and are reported as counts, only when they change.

const MAX_GAP_SECONDS = 15;
const MAX_TEXT_LENGTH = 200;

export function normalizeText(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function levenshtein(a, b) {
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const digitsOf = (s) => s.replace(/\D+/g, '');

/**
 * True for identical or nearly identical OCR strings (normalized). Numbers must match exactly
 * ("INVOICE 4821" is not "INVOICE 4822"); letters may differ by OCR flicker ("OR" / "CR").
 */
export function similarText(a, b) {
  if (a === b) return true;
  if (digitsOf(a) !== digitsOf(b)) return false;
  const x = a.slice(0, 80);
  const y = b.slice(0, 80);
  const max = Math.max(x.length, y.length);
  if (max < 4 || Math.abs(x.length - y.length) > max * 0.3) return false;
  return 1 - levenshtein(x, y) / max >= (max < 10 ? 0.9 : 0.8);
}

/** OCR fragments with fewer than 3 letters/digits ("OR", "1a", "} f") are noise, not text. */
export const meaningfulText = (key) => key.replace(/[^\p{L}\p{N}]+/gu, '').length >= 3;

const containsSimilar = (list, key) => list.some((k) => similarText(k, key));

export const formatObjects = (objects) =>
  Object.entries(objects)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(', ');

function summarizeFaces(faceLists) {
  const counts = new Map();
  let total = 0;
  let maxFaces = 0;
  for (const faces of faceLists) {
    maxFaces = Math.max(maxFaces, faces.length);
    for (const face of faces) {
      if (!face?.expression) continue;
      counts.set(face.expression, (counts.get(face.expression) ?? 0) + 1);
      total++;
    }
  }
  if (total === 0) return '';
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([expr, n]) => `${expr} ${Math.round((n / total) * 100)}%`);
  return `${maxFaces} (${parts.join(', ')})`;
}

/**
 * @param {object} analysis analysis v2
 * @param {{ compact?: boolean }} [options] compact drops per-window objects and faces (to save tokens)
 */
export function buildTimeline(analysis, { compact = false } = {}) {
  const frames = [...(analysis?.frames ?? [])].filter((f) => Number.isFinite(f?.t)).sort((a, b) => a.t - b.t);
  const transcript = [...(analysis?.transcript ?? [])]
    .filter((s) => Number.isFinite(s?.start) && Number.isFinite(s?.end) && String(s.text ?? '').trim())
    .sort((a, b) => a.start - b.start);
  const lastFrame = frames.length ? frames[frames.length - 1].t : 0;
  const duration = Math.max(analysis?.video?.duration ?? 0, lastFrame, transcript.at(-1)?.end ?? 0);

  // --- windows --------------------------------------------------------------------------------
  const cuts = frames.filter((f) => f.sceneCut && f.t > 0).map((f) => f.t);
  const windows = [];
  const pushGap = (start, end) => {
    let cursor = start;
    const boundaries = cuts.filter((t) => t > start && t < end);
    for (const boundary of [...boundaries, end]) {
      while (boundary - cursor > MAX_GAP_SECONDS) {
        windows.push({ start: cursor, end: cursor + MAX_GAP_SECONDS, speech: '' });
        cursor += MAX_GAP_SECONDS;
      }
      if (boundary > cursor) windows.push({ start: cursor, end: boundary, speech: '' });
      cursor = boundary;
    }
  };
  let cursor = 0;
  for (const segment of transcript) {
    const start = Math.max(segment.start, cursor);
    const end = Math.max(segment.end, start);
    if (start > cursor) pushGap(cursor, start);
    windows.push({ start, end, speech: String(segment.text).trim() });
    cursor = end;
  }
  if (lastFrame >= cursor && frames.length) pushGap(cursor, Math.max(lastFrame, cursor) + 1e-9);
  if (windows.length === 0 && frames.length) windows.push({ start: 0, end: lastFrame + 1e-9, speech: '' });

  // --- global statistics -------------------------------------------------------------------------
  const objectFrames = new Map();
  const objectMax = {};
  for (const f of frames) {
    for (const [label, count] of Object.entries(f.objects ?? {})) {
      objectFrames.set(label, (objectFrames.get(label) ?? 0) + 1);
      objectMax[label] = Math.max(objectMax[label] ?? 0, count);
    }
  }
  const minFrames = frames.length >= 3 ? 2 : 1;
  const persistent = new Set([...objectFrames].filter(([, n]) => n >= minFrames).map(([label]) => label));
  const objects = Object.fromEntries(Object.entries(objectMax).filter(([label]) => persistent.has(label)));

  // Background text (logos, watermarks, tickers): visible in at least half of the frames that show any
  // text (needs >= 8 such frames) and - when scene cuts are known - in more than one scene. Text that
  // belongs to a single scene is content, and keeps its place on the timeline.
  const sceneCount = 1 + frames.filter((f) => f.sceneCut && f.t > 0).length;
  const framesWithText = frames.filter((f) => (f.texts ?? []).some((t) => meaningfulText(normalizeText(t))));
  const background = [];
  const backgroundKeys = [];
  if (framesWithText.length >= 8) {
    const groups = []; // { key, display, frames, scenes }
    let scene = 0;
    for (const f of frames) {
      if (f.sceneCut && f.t > 0) scene++;
      const seen = [];
      for (const raw of f.texts ?? []) {
        const key = normalizeText(raw);
        if (!meaningfulText(key) || containsSimilar(seen, key)) continue;
        seen.push(key);
        const group = groups.find((g) => similarText(g.key, key));
        if (group) {
          group.frames++;
          group.scenes.add(scene);
        } else {
          groups.push({ key, display: String(raw).trim(), frames: 1, scenes: new Set([scene]) });
        }
      }
    }
    for (const g of groups) {
      if (g.frames / framesWithText.length >= 0.5 && (sceneCount < 2 || g.scenes.size >= 2)) {
        background.push(g.display.slice(0, MAX_TEXT_LENGTH));
        backgroundKeys.push(g.key);
      }
    }
  }

  // --- per-window content ----------------------------------------------------------------------
  let f = 0;
  let previousTexts = [];
  let previousObjects = '';
  const result = [];
  windows.forEach((w, index) => {
    const isLast = index === windows.length - 1;
    const inWindow = [];
    while (f < frames.length && (frames[f].t < w.end || (isLast && frames[f].t <= w.end))) {
      if (frames[f].t >= w.start) inWindow.push(frames[f]);
      f++;
    }

    const texts = [];
    const keys = [];
    for (const frame of inWindow) {
      for (const raw of frame.texts ?? []) {
        const key = normalizeText(raw);
        if (!meaningfulText(key) || containsSimilar(keys, key) || containsSimilar(backgroundKeys, key)) continue;
        keys.push(key);
        if (!containsSimilar(previousTexts, key)) texts.push(String(raw).trim().slice(0, MAX_TEXT_LENGTH));
      }
    }
    previousTexts = keys.length ? keys : previousTexts;

    let objectText = '';
    if (!compact) {
      const windowObjects = {};
      for (const frame of inWindow) {
        for (const [label, count] of Object.entries(frame.objects ?? {})) {
          if (persistent.has(label)) windowObjects[label] = Math.max(windowObjects[label] ?? 0, count);
        }
      }
      const formatted = formatObjects(windowObjects);
      if (formatted && formatted !== previousObjects) objectText = formatted;
      if (formatted) previousObjects = formatted;
    }

    const captions = inWindow
      .filter((fr) => fr.caption)
      .map((fr) =>
        String(fr.caption)
          .trim()
          .slice(0, compact ? 120 : 400),
      );
    const faces = compact ? '' : summarizeFaces(inWindow.filter((fr) => Array.isArray(fr.faces)).map((fr) => fr.faces));
    const sceneCuts = inWindow.filter((fr) => fr.sceneCut && fr.t > 0).map((fr) => fr.t);

    if (w.speech || texts.length || objectText || captions.length || faces || sceneCuts.length) {
      result.push({
        start: w.start,
        end: Math.min(w.end, Math.max(duration, w.start)),
        speech: w.speech,
        texts,
        objects: objectText,
        captions,
        faces,
        sceneCuts,
      });
    }
  });

  return { duration, windows: result, background, objects, hasSpeech: transcript.length > 0 };
}
