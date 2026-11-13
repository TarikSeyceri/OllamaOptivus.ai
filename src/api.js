const router = require("express").Router();

const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const util = require("util");

const dataRefactory = require("./data-refactory");
const { HttpError } = require("./http-errors");
const { resolveInsideRoots, sanitizeFileName } = require("./paths");

const execFilePromise = util.promisify(execFile);

const NODE_ENV = process.env.NODE_ENV === "development" ? "development" : "production";
const VIDEOS_DIR = process.env.VIDEOS_DIR || "data/videos";
const AUDIOS_DIR = process.env.AUDIOS_DIR || "data/audios";
const JSON_DATA_DIR = process.env.JSON_DATA_DIR || "data/json";
const PROMPTS_DIR = process.env.PROMPTS_DIR || "data/prompts";
const VIDEO_FILE_MAX_UPLOAD_SIZE = parseInt(process.env.VIDEO_FILE_MAX_UPLOAD_SIZE || 500 * 1024 * 1024, 10);
const PROCESSING_ONLY = process.env.PROCESSING_ONLY?.toLowerCase() === "true";
const ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR = process.env.ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR?.toLowerCase() === "true";
const ENABLE_PROCESS_LOCK_MECHANISM = process.env.ENABLE_PROCESS_LOCK_MECHANISM?.toLowerCase() !== "false";
const PYTHON_BINARY_PATH = process.env.PYTHON_BINARY_PATH || (process.platform === "win32" ? "python" : "python3");
const PROCESSING_TIMEOUT_MS = parseInt(process.env.PROCESSING_TIMEOUT_MS || 2 * 60 * 60 * 1000, 10);
const OLLAMA_AI_MODEL = process.env.OLLAMA_AI_MODEL || "qwen3.5:4b";
const OLLAMA_AI_TEMPERATURE = parseFloat(process.env.OLLAMA_AI_TEMPERATURE || 0);
const OLLAMA_AI_DISABLED = process.env.OLLAMA_AI_DISABLED?.toLowerCase() === "true";

if (ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR) {
    console.warn("ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR=true lets /process read ANY .mp4 file this process can access.");
}

let lockProcess = false;
const systemLanguages = {
    en: "Answer in english language only.",
    tr: "Sadece Türkçe dilinde cevap ver.",
};

const ollamaDefaultOutputFormat = {
    type: "object",
    properties: {
        summary: { type: "string" },
        events: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    timestamp: { type: "number" },
                    description: { type: "string" },
                },
                required: ["timestamp", "description"],
            },
        },
    },
    required: ["summary", "events"],
};

// MP4/MOV/M4V/3GP files carry an "ftyp" box at byte offset 4.
async function looksLikeMp4(filePath) {
    const handle = await fs.promises.open(filePath, "r");
    try {
        const { bytesRead, buffer } = await handle.read(Buffer.alloc(12), 0, 12, 0);
        return bytesRead >= 8 && buffer.toString("latin1", 4, 8) === "ftyp";
    } finally {
        await handle.close();
    }
}

// The child process gets the environment minus anything that looks like a credential.
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !SECRET_ENV.test(key)));

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, VIDEOS_DIR),
        // Written under a random temporary name; renamed only after validation.
        filename: (req, file, cb) => cb(null, `.upload-${crypto.randomUUID()}.part`),
    }),
    limits: { fileSize: VIDEO_FILE_MAX_UPLOAD_SIZE, files: 1, fields: 10, parts: 12 },
    fileFilter: (req, file, cb) => {
        const safeName = sanitizeFileName(file.originalname);
        if (!safeName || path.extname(safeName) !== ".mp4" || file.mimetype !== "video/mp4") {
            return cb(new HttpError(415, "Only .mp4 video files are allowed"));
        }
        req.safeVideoName = safeName;
        return cb(null, true);
    },
});

function rejectWhenProcessingOnly(action) {
    return (req, res, next) => {
        if (!PROCESSING_ONLY) return next();
        console.warn(`Video file ${action} disabled in this environment!`);
        return res.status(403).json({ success: false, msg: `Video file ${action} disabled in this environment!` });
    };
}

// Endpoint: Root
router.get("/", (req, res) => {
    res.status(200).json({ success: true, msg: "Ollama Optivus Server is running!" });
});

// Endpoint: Upload video file
router.post("/upload", rejectWhenProcessingOnly("upload"), upload.single("video"), async (req, res) => {
    const video = req.file;
    if (!video) {
        console.warn("Video file not uploaded!");
        return res.status(400).json({ success: false, msg: "Video file not uploaded!" });
    }

    try {
        if (!(await looksLikeMp4(video.path))) {
            throw new HttpError(415, "The uploaded file is not a valid MP4 video");
        }
        const videoFilePath = path.join(VIDEOS_DIR, req.safeVideoName);
        if (fs.existsSync(videoFilePath)) {
            console.warn(`Video file already exists: ${videoFilePath}`);
        } else {
            await fs.promises.rename(video.path, videoFilePath);
            console.log("Video file uploaded!", req.safeVideoName);
        }
        return res.status(200).json({ success: true, msg: "Video file uploaded!", payload: { videoFilePath } });
    } finally {
        await fs.promises.rm(video.path, { force: true });
    }
});

// Endpoint: List video files
router.get("/videos", rejectWhenProcessingOnly("listing"), async (req, res) => {
    const entries = await fs.promises.readdir(VIDEOS_DIR, { withFileTypes: true });
    const videos = entries
        .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
        .map((entry) => path.join(VIDEOS_DIR, entry.name));
    console.log("Video files listed!", videos.length);
    return res.status(200).json({ success: true, msg: "Video files listed!", payload: { videos } });
});

// Endpoint: Delete video file by name
router.delete("/delete", rejectWhenProcessingOnly("deletion"), async (req, res) => {
    const { videoFileName } = req.body ?? {};
    if (typeof videoFileName !== "string" || !videoFileName.trim()) {
        console.warn("videoFileName not provided!");
        return res.status(400).json({ success: false, msg: "videoFileName not provided!" });
    }

    const fileName = path.basename(videoFileName.replace(/\\/g, "/"));
    const videoFilePath = path.join(VIDEOS_DIR, fileName);
    if (fileName.startsWith(".") || !fs.existsSync(videoFilePath)) {
        console.warn("Video file not found!", videoFilePath);
        return res.status(404).json({ success: false, msg: "Video file not found!" });
    }
    await fs.promises.unlink(videoFilePath);

    // Remove everything derived from this video (audio, cached analyses, prompts).
    const stem = path.basename(fileName, path.extname(fileName));
    for (const dir of [AUDIOS_DIR, JSON_DATA_DIR, PROMPTS_DIR]) {
        const entries = await fs.promises.readdir(dir).catch(() => []);
        for (const entry of entries) {
            if (entry.startsWith(`${stem}.`) || entry.startsWith(`${stem}_`)) {
                await fs.promises.rm(path.join(dir, entry), { force: true });
            }
        }
    }

    console.log("Video file deleted!", fileName);
    return res.status(200).json({ success: true, msg: "Video file deleted!" });
});

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------
function validateProcessBody(body) {
    const { videoFilePath, language, videoExplanation, model, temperature, format, noPrompting } = body;
    if (videoFilePath !== undefined && typeof videoFilePath !== "string") return "videoFilePath must be a string";
    if (videoExplanation !== undefined && (typeof videoExplanation !== "string" || videoExplanation.length > 4000)) {
        return "videoExplanation must be a string of at most 4000 characters";
    }
    if (model !== undefined && (typeof model !== "string" || !/^[\w.:/-]{1,200}$/.test(model))) return "model must be a valid model name";
    if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 2)) {
        return "temperature must be a number between 0 and 2";
    }
    if (format !== undefined && format !== "json" && (typeof format !== "object" || format === null || Array.isArray(format))) {
        return 'format must be "json" or a JSON schema object';
    }
    if (noPrompting !== undefined && typeof noPrompting !== "boolean") return "noPrompting must be a boolean";
    if (language !== undefined && typeof language !== "string") return "language must be a string";
    return null;
}

// Endpoint: Process file
router.post("/process", async (req, res) => {
    const body = req.body ?? {};
    const problem = validateProcessBody(body);
    if (problem) {
        return res.status(400).json({ success: false, msg: problem });
    }
    const { videoFilePath, videoExplanation, model, temperature, format, noPrompting } = body;
    const language = Object.hasOwn(systemLanguages, body.language ?? "") ? body.language : "en";
    const systemLanguage = systemLanguages[language];

    if (lockProcess) {
        console.warn("Processing already in progress!");
        return res.status(503).json({ success: false, msg: "Another processing request already in progress!, please try again later." });
    }

    if (!videoFilePath) {
        console.warn("videoFilePath not provided!");
        return res.status(400).json({ success: false, msg: "Video file path not provided!" });
    }

    const resolved = ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR
        ? await resolveInsideRoots(videoFilePath, [path.parse(path.resolve(videoFilePath)).root])
        : await resolveInsideRoots(videoFilePath, [VIDEOS_DIR]);
    if (resolved.error === "forbidden") {
        console.warn("Video file path not allowed!", videoFilePath);
        return res.status(403).json({ success: false, msg: "Video file path not allowed!" });
    }
    if (resolved.error === "not_found") {
        console.warn("Video file not found!", videoFilePath);
        return res.status(404).json({ success: false, msg: "Video file not found!" });
    }
    const resolvedPath = resolved.path;

    if (path.extname(resolvedPath).toLowerCase() !== ".mp4" || !(await looksLikeMp4(resolvedPath).catch(() => false))) {
        console.warn("Invalid file type!", videoFilePath);
        return res.status(400).json({ success: false, msg: "Invalid file type!" });
    }

    const ollama = req.app.locals.ollama;
    if (!(OLLAMA_AI_DISABLED || noPrompting) && !(await ollama?.waitUntilReady(30_000))) {
        return res.status(503).json({ success: false, msg: "The AI model is not ready yet, please try again later." });
    }

    lockProcess = ENABLE_PROCESS_LOCK_MECHANISM;
    req.app.locals.filesInUse ??= new Set();
    req.app.locals.filesInUse.add(resolvedPath);
    try {
        console.log("Processing video file", videoFilePath);

        let stdout;
        try {
            ({ stdout } = await execFilePromise(PYTHON_BINARY_PATH, [path.join(__dirname, "processor.py"), resolvedPath, language], {
                env: childEnv(),
                maxBuffer: 512 * 1024 * 1024,
                timeout: PROCESSING_TIMEOUT_MS,
                windowsHide: true,
            }));
        } catch (error) {
            const detail = error.killed ? `timed out after ${PROCESSING_TIMEOUT_MS} ms` : (error.stderr || error.message);
            console.error("Processing failed for video file", videoFilePath, detail);
            return res.status(500).json({ success: false, msg: "Processing failed" });
        }

        let analysis;
        try {
            analysis = JSON.parse(stdout);
        } catch {
            console.error("Processor returned invalid JSON for video file", videoFilePath);
            return res.status(500).json({ success: false, msg: "Processing failed" });
        }

        const prompt = dataRefactory.getPrompt(analysis, language, videoExplanation);
        const promptFilePath = path.join(PROMPTS_DIR, `${path.basename(resolvedPath, path.extname(resolvedPath))}_${language}.txt`);
        await fs.promises.writeFile(promptFilePath, prompt, "utf8");

        if (OLLAMA_AI_DISABLED || noPrompting) {
            return res.status(200).json({ success: true, msg: "Processing completed, without prompting.", payload: { stdout, prompt } });
        }

        console.log("Prompting video file", videoFilePath);
        const response = await ollama.generate({
            model: model ?? OLLAMA_AI_MODEL,
            system: systemLanguage,
            prompt,
            temperature: temperature ?? OLLAMA_AI_TEMPERATURE,
            format: format ?? ollamaDefaultOutputFormat,
        });

        console.log("Processing completed for video file", videoFilePath);
        if (NODE_ENV === "development") console.log("LLM response", response);
        return res.status(200).json({ success: true, msg: "Processing completed", payload: { response } });
    } catch (error) {
        console.error("Processing failed for video file", videoFilePath, error);
        return res.status(500).json({ success: false, msg: "Processing failed" });
    } finally {
        lockProcess = false;
        req.app.locals.filesInUse.delete(resolvedPath);
    }
});

module.exports = router;
