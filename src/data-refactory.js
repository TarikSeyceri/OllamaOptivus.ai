// Turns the processor's analysis ({ frames, audioTranscription }) into a time-ordered text prompt.

const languages = {
    en: {
        videoExplanation: "The following info is the output of an analysis of a video:",
        betweenSecond: "Between second",
        andSecond: "and second",
        audioTranscription: "Audio transcription",
        onScreenText: "On screen text",
        objectsDetected: "Objects detected",
    },
    tr: {
        videoExplanation: "Aşağıdaki bilgiler, bir video analizinin çıktısıdır:",
        betweenSecond: "Arasında saniye",
        andSecond: "ve saniye",
        audioTranscription: "Ses transkripsiyonu",
        onScreenText: "Ekrandaki metin",
        objectsDetected: "Algılanan nesneler",
    },
};

const isBlank = (text) => !text || !String(text).trim();
const formatSecond = (t) => String(Math.round(t * 10) / 10);
const normalizeText = (text) => String(text).trim().toLowerCase();

/**
 * Splits the whole video into consecutive time windows: speech segments plus the gaps before,
 * between and after them. Every frame belongs to exactly one window (half-open intervals, the
 * last window is closed), so nothing is dropped and nothing is counted twice.
 */
function buildSegments(analysis) {
    const frames = [...(analysis?.frames ?? [])]
        .filter((frame) => Number.isFinite(frame?.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp);
    const speech = [...(analysis?.audioTranscription ?? [])]
        .filter((segment) => Number.isFinite(segment?.start) && Number.isFinite(segment?.end))
        .sort((a, b) => a.start - b.start);

    const windows = [];
    let cursor = 0;
    for (const segment of speech) {
        const start = Math.max(segment.start, cursor);
        const end = Math.max(segment.end, start);
        if (start > cursor) windows.push({ start: cursor, end: start, text: "" });
        windows.push({ start, end, text: segment.text ?? "" });
        cursor = end;
    }
    const lastFrame = frames.length ? frames[frames.length - 1].timestamp : -Infinity;
    if (lastFrame >= cursor) windows.push({ start: cursor, end: lastFrame, text: "" });

    let f = 0;
    return windows
        .map((window, index) => {
            const isLast = index === windows.length - 1;
            const texts = new Set();
            const detections = new Set();
            while (f < frames.length && (frames[f].timestamp < window.end || (isLast && frames[f].timestamp <= window.end))) {
                if (frames[f].timestamp >= window.start) {
                    (frames[f].texts ?? []).forEach((t) => !isBlank(t) && texts.add(String(t).trim()));
                    (frames[f].detections ?? []).forEach((d) => !isBlank(d) && detections.add(String(d).trim()));
                }
                f++;
            }
            return {
                startTimestamp: window.start,
                endTimestamp: window.end,
                audioTranscription: window.text,
                onScreenTexts: [...texts],
                detections: [...detections],
            };
        })
        .filter((s) => !isBlank(s.audioTranscription) || s.onScreenTexts.length > 0 || s.detections.length > 0);
}

/**
 * Removes on-screen texts that are most likely static background (logos, watermarks, tickers):
 * an individual text that appears in at least half of the windows that contain text at all.
 * With fewer than 8 such windows there is not enough evidence, so nothing is removed.
 */
function clearBackgroundOnScreenTexts(segments) {
    const withText = segments.filter((s) => s.onScreenTexts.length > 0);
    if (withText.length < 8) return segments;

    const counts = new Map();
    for (const segment of withText) {
        for (const text of new Set(segment.onScreenTexts.map(normalizeText))) {
            counts.set(text, (counts.get(text) ?? 0) + 1);
        }
    }
    const background = new Set([...counts].filter(([, count]) => count / withText.length >= 0.5).map(([text]) => text));
    if (background.size === 0) return segments;
    return segments.map((s) => ({ ...s, onScreenTexts: s.onScreenTexts.filter((t) => !background.has(normalizeText(t))) }));
}

function generatePrompt(segments, labels) {
    const lines = [labels.videoExplanation];
    for (const s of segments) {
        let line = `${labels.betweenSecond} ${formatSecond(s.startTimestamp)} ${labels.andSecond} ${formatSecond(s.endTimestamp)}`;
        if (!isBlank(s.audioTranscription)) line += `, ${labels.audioTranscription}:${s.audioTranscription}`;
        if (s.onScreenTexts.length > 0) line += `. ${labels.onScreenText}: ${s.onScreenTexts.join(", ")}.`;
        if (s.detections.length > 0) line += `. ${labels.objectsDetected}: ${s.detections.join(", ")}.`;
        lines.push(line);
    }
    return lines.join("\n");
}

function getPrompt(analysis, lang, videoExplanation) {
    // Copy the label set: per-request values must never leak into later requests.
    const labels = { ...(Object.hasOwn(languages, lang ?? "") ? languages[lang] : languages.en) };
    if (typeof videoExplanation === "string" && videoExplanation.trim()) {
        labels.videoExplanation = videoExplanation.trim();
    }
    return generatePrompt(clearBackgroundOnScreenTexts(buildSegments(analysis)), labels);
}

module.exports = { getPrompt, buildSegments, clearBackgroundOnScreenTexts };
