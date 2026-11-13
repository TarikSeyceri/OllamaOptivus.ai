// The analysis document exchanged between the analysis backend, the cache and the prompt builder.
//
// v2 shape (what the worker produces):
// {
//   analysisVersion: 2,
//   video: { duration, width?, height?, fps?, hasAudio },
//   language, detectedLanguage?,
//   transcript: [{ start, end, text }],                      // seconds, floats
//   frames: [{ t, objects: { label: count }, texts: [..], sceneCut?, faces?: [{ expression, score }],
//              keyframe?: "frames/<dir>/<file>.jpg", caption? }],
//   scenes?: [{ start, end }],
//   timings?, models?, device?
// }
//
// v1 shape (legacy processor and the legacy `noPrompting` response):
// { frames: [{ timestamp, detections: [label, ...], texts: [..] }], audioTranscription: [{ start, end, text }] }

export const ANALYSIS_VERSION = 2;

const finite = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback);

/** Converts a legacy v1 analysis to v2. */
export function fromLegacy(v1, { language } = {}) {
  const frames = (v1?.frames ?? []).map((f) => {
    const objects = {};
    for (const label of f.detections ?? []) objects[label] = (objects[label] ?? 0) + 1;
    return { t: finite(f.timestamp), objects, texts: [...(f.texts ?? [])] };
  });
  const transcript = (v1?.audioTranscription ?? []).map((s) => ({ start: finite(s.start), end: finite(s.end), text: s.text ?? '' }));
  const duration = Math.max(0, ...frames.map((f) => f.t), ...transcript.map((s) => s.end));
  return {
    analysisVersion: ANALYSIS_VERSION,
    video: { duration, hasAudio: transcript.length > 0 },
    language,
    transcript,
    frames,
  };
}

/** Converts a v2 analysis to the v1 shape (for legacy clients). */
export function toLegacy(v2) {
  return {
    frames: (v2?.frames ?? []).map((f) => ({
      timestamp: f.t,
      detections: Object.entries(f.objects ?? {}).flatMap(([label, count]) => Array(Math.min(count, 50)).fill(label)),
      texts: [...(f.texts ?? [])],
    })),
    audioTranscription: (v2?.transcript ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
  };
}

/** Compact numbers for job status responses and logs (no transcript content). */
export function describeAnalysis(v2) {
  return {
    duration: v2?.video?.duration,
    hasAudio: v2?.video?.hasAudio,
    transcriptSegments: v2?.transcript?.length ?? 0,
    sampledFrames: v2?.frames?.length ?? 0,
    sceneCuts: v2?.frames?.filter((f) => f.sceneCut).length ?? 0,
    keyframes: v2?.frames?.filter((f) => f.keyframe).length ?? 0,
    device: v2?.device,
  };
}
