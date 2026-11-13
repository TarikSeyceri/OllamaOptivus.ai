// Languages: what can be requested, how the prompt is labelled and how the answer language is set.

/** Languages Whisper can transcribe (ISO 639-1 / 639-3 codes as used by Whisper). */
// prettier-ignore
export const WHISPER_LANGUAGES = [
  'af', 'am', 'ar', 'as', 'az', 'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en',
  'es', 'et', 'eu', 'fa', 'fi', 'fo', 'fr', 'gl', 'gu', 'ha', 'haw', 'he', 'hi', 'hr', 'ht', 'hu', 'hy', 'id', 'is',
  'it', 'ja', 'jw', 'ka', 'kk', 'km', 'kn', 'ko', 'la', 'lb', 'ln', 'lo', 'lt', 'lv', 'mg', 'mi', 'mk', 'ml', 'mn',
  'mr', 'ms', 'mt', 'my', 'ne', 'nl', 'nn', 'no', 'oc', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'sa', 'sd', 'si', 'sk',
  'sl', 'sn', 'so', 'sq', 'sr', 'su', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk', 'tl', 'tr', 'tt', 'uk', 'ur', 'uz',
  'vi', 'yi', 'yo', 'yue', 'zh',
];

const LABELS = {
  en: {
    context: 'The following is an automatic analysis of a video.',
    speech: 'Speech',
    onScreen: 'On-screen text',
    objects: 'Objects',
    scene: 'Scene',
    sceneChange: 'Scene change',
    faces: 'Faces',
    persistentText: 'Text visible during most of the video',
    allObjects: 'Objects seen in the video',
    duration: 'Duration',
    seconds: 's',
    language: 'Language',
    noSpeech: 'The video contains no recognizable speech.',
  },
  tr: {
    context: 'Aşağıdakiler bir videonun otomatik analizidir.',
    speech: 'Konuşma',
    onScreen: 'Ekrandaki metin',
    objects: 'Nesneler',
    scene: 'Sahne',
    sceneChange: 'Sahne değişimi',
    faces: 'Yüzler',
    persistentText: 'Videonun çoğunda görünen metin',
    allObjects: 'Videoda görülen nesneler',
    duration: 'Süre',
    seconds: 'sn',
    language: 'Dil',
    noSpeech: 'Videoda anlaşılır bir konuşma yok.',
  },
};

const ANSWER_INSTRUCTIONS = {
  en: 'Write every text value of the JSON answer in English.',
  tr: 'JSON cevabındaki tüm metin değerlerini Türkçe yaz.',
};

/** Prompt labels for a language (English for languages without a translation). */
export const labelsFor = (language) => (Object.hasOwn(LABELS, language ?? '') ? LABELS[language] : LABELS.en);

/** Human-readable English name of a language code, e.g. "de" -> "German". */
export function languageName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The instruction that sets the answer language. */
export function answerInstruction(language) {
  if (Object.hasOwn(ANSWER_INSTRUCTIONS, language ?? '')) return ANSWER_INSTRUCTIONS[language];
  return `Write every text value of the JSON answer in ${languageName(language)}.`;
}
