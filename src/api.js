const router = require("express").Router();

const multer = require("multer");
const fs = require("fs");
const path = require('path');
const mimeTypes = require('mime-types');
const { exec } = require("child_process");
const util = require("util");
const ollama = require('ollama').default;

const dataRefactory = require("./data-refactory");

const asyncExec = util.promisify(exec);

const VIDEOS_DIR = process.env.VIDEOS_DIR || "data/videos";
const VIDEO_FILE_MAX_UPLOAD_SIZE = parseInt(process.env.VIDEO_FILE_MAX_UPLOAD_SIZE || 500 * 1024 * 1024); // Default 500MB
const PROMPTS_DIR = process.env.PROMPTS_DIR || "data/prompts";
const PROCESSING_ONLY = process.env.PROCESSING_ONLY == "true";
const ALLOW_PROCESS_VIDEOS_OUTSIDE_UPLOAD_DIR = process.env.ALLOW_PROCESS_VIDEOS_OUTSIDE_UPLOAD_DIR == "true";
const ENABLE_PROCESS_LOCK_MECHANISM = process.env.ENABLE_PROCESS_LOCK_MECHANISM == "true";
const PYTHON_BINARY_PATH = process.env.PYTHON_BINARY_PATH || "python3";
const OLLAMA_AI_MODEL = process.env.OLLAMA_AI_MODEL || "deepseek-r1";
const OLLAMA_AI_TEMPERATURE = parseFloat(process.env.OLLAMA_AI_TEMPERATURE || 0);

var lockProcess = false;
const systemLanguages = {
    en: "Answer in english language only.",
    tr: "Sadece Türkçe dilinde cevap ver."
}

const ollamaDefaultOutputFormat = {
    "type": "object",
    "properties": {
      "summary": {
        "type": "string"
      },
      "events": {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "timestamp": {
                    "type": "number"
                },
                "description": {
                    "type": "string"
                }
            },
            "required": ["timestamp", "description"]
        }
      }
    },
    "required": [
      "summary",
      "events"
    ]
};

// Setup multer for video file uploads
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, VIDEOS_DIR);
        },
        filename: (req, file, cb) => {
            cb(null, file.originalname);
        },
    }),
    limits: { fileSize: VIDEO_FILE_MAX_UPLOAD_SIZE },
    fileFilter: (req, file, cb) => {
        const videoFilePath = path.join(VIDEOS_DIR, file.originalname);

        // Check MIME type and extension
        if (path.extname(file.originalname).toLowerCase() !== ".mp4" || !["video/mp4"].includes(file.mimetype)) {
            return cb(new Error("Only .mp4 video files are allowed"));
        }

        // Check if the file already exists
        if (fs.existsSync(videoFilePath)) {
            req.existingVideoFilePath = videoFilePath;
            return cb(null, false);
        }

        cb(null, true);
    },
});

// Endpoint: Upload video file
router.post("/upload", upload.single("video"), (req, res) => {
    const video = req.video;

    if (PROCESSING_ONLY) {
        console.warn("Video file upload disabled in this environment!");
        return res.status(403).json({ success: false, msg: "Video file upload disabled in this environment!" });
    }

    if (req.existingVideoFilePath) {
        console.warn(`Video file already exists: ${req.existingVideoFilePath}`);
        return res.status(200).json({ success: true, msg: "Video file uploaded!", payload: { videoFilePath: req.existingVideoFilePath } });
    }

    if (!video) {
        console.error("Video file not uploaded!");
        return res.status(400).json({ success: false, msg: "Video file not uploaded!" });
    }

    console.log("Video file uploaded!", video.originalname);
    return res.status(200).json({ success: true, msg: "Video file uploaded!", payload: { videoFilePath: path.join(VIDEOS_DIR, video.originalname) } });
});

// Endpoint: List video files
router.get("/videos", (req, res) => {
    if (PROCESSING_ONLY) {
        console.warn("Video files listing disabled in this environment!");
        return res.status(403).json({ success: false, msg: "Video files listing disabled in this environment!" });
    }

    const videos = fs.readdirSync(VIDEOS_DIR);
    if (videos.length > 0) {
        for (let i = 0; i < videos.length; i++) {
            videos[i] = path.join(VIDEOS_DIR, videos[i]);
        }
    }
    console.log("Video files listed!", videos);
    return res.status(200).json({ success: true, msg: "Video files listed!", payload: { videos } });
});

// Endpoint: Delete video file by path
router.delete("/delete", (req, res) => {
    const { videoFilePath } = req.query;

    if (PROCESSING_ONLY) {
        console.warn("Video file deletion disabled in this environment!");
        return res.status(403).json({ success: false, msg: "Video file deletion disabled in this environment!" });
    }

    if (!videoFilePath) {
        console.warn("videoFilePath not provided!");
        return res.status(400).json({ success: false, msg: "videoFilePath not provided!" });
    }

    if (!videoFilePath.includes(path.join(VIDEOS_DIR, path.basename(videoFilePath)))) {
        console.warn("videoFilePath not allowed!", videoFilePath);
        return res.status(403).json({ success: false, msg: "videoFilePath not allowed!" });
    }

    if (!fs.existsSync(videoFilePath)) {
        console.warn("Video file not found!", videoFilePath);
        return res.status(200).json({ success: true, msg: "Video file deleted!" });
    }

    fs.unlinkSync(videoFilePath);
    console.log("Video file deleted!", videoFilePath);
    return res.status(200).json({ success: true, msg: "Video file deleted!" });
});

// Endpoint: Process file
router.post("/process", async (req, res) => {
    let { videoFilePath, language, videoExplanation, model, temperature, format } = req.body;

    if(!language || !systemLanguages[language]){
        language = "en";
    }
    const systemLanguage = systemLanguages[language];

    if(lockProcess){
        console.warn("Processing already in progress!");
        return res.status(503).json({ success: false, msg: "Another processing request already in progress!, please try again later." });
    }

    if (!videoFilePath) {
        console.warn("videoFilePath not provided!");
        return res.status(400).json({ success: false, msg: "Video file path not provided!" });
    }

    if (!ALLOW_PROCESS_VIDEOS_OUTSIDE_UPLOAD_DIR && !videoFilePath.includes(path.join(VIDEOS_DIR, path.basename(videoFilePath)))) {
        console.warn("Video file path not allowed!", videoFilePath);
        return res.status(403).json({ success: false, msg: "Video file path not allowed!" });
    }

    if (!fs.existsSync(videoFilePath)) {
        console.warn("Video file not found!", videoFilePath);
        return res.status(404).json({ success: false, msg: "Video file not found!" });
    }

    const fileExtension = path.extname(videoFilePath).toLowerCase(); // e.g. ".mp4"
    const fileMimeType = mimeTypes.lookup(videoFilePath); // e.g. "video/mp4" if extension is .mp4

    if (fileExtension != '.mp4' || fileMimeType != 'video/mp4') {
        console.warn("Invalid file type!", videoFilePath);
        return res.status(400).json({ success: false, msg: "Invalid file type!" });
    }

    try {
        lockProcess = ENABLE_PROCESS_LOCK_MECHANISM;

        console.log("Processing video file", videoFilePath);

        const { stdout, stderr } = await asyncExec(`${PYTHON_BINARY_PATH} ${__dirname}/processor.py ${videoFilePath} ${language}`);
        if (stderr) {
            lockProcess = false;
            console.error("Processing failed for video file", videoFilePath, stderr);
            return res.status(500).json({ success: false, msg: "Processing failed" });
        }

        const promptFilePath = PROMPTS_DIR + '/' + path.basename(videoFilePath, path.extname(videoFilePath)) + "_" + language + ".txt";
        const prompt = dataRefactory.getPrompt(JSON.parse(stdout), language, videoExplanation);
        await fs.promises.writeFile(promptFilePath, prompt, 'utf8');

        console.log("Prompting video file", videoFilePath);
        
        const response = await ollama.generate({
            model: model ?? OLLAMA_AI_MODEL,
            system: systemLanguage,
            prompt,
            stream: false,
            options: {
                temperature: temperature ?? OLLAMA_AI_TEMPERATURE
            },
            format: format ?? ollamaDefaultOutputFormat,
        });

        lockProcess = false;
        if (response) {
            console.log("Processing completed for video file", videoFilePath);
            return res.status(200).json({ success: true, msg: "Processing completed", payload: { response: response?.response } });
        }
        
        console.log("Processing failed for video file", videoFilePath);
        return res.status(500).json({ success: false, msg: "Processing failed" });
    }
    catch (error) {
        lockProcess = false;
        console.error("Processing failed for video file", videoFilePath, error);
        return res.status(500).json({ success: false, msg: "Processing failed" });
    }
});

router.post("/test", async (req, res) => {
    const videoFilePath = "/dummy/location/video.mp4";

    try {
        const { stdout, stderr } = await asyncExec(`${PYTHON_BINARY_PATH} ${__dirname}/test/test.py`);
        if (stderr) {
            console.error("Processing failed for video file", videoFilePath, stderr);
            return res.status(500).json({ success: false, msg: "Processing failed" });
        }

        const jsonData = JSON.parse(stdout);
        const prompt = dataRefactory.getPrompt(jsonData);

        console.log("Processed video file", videoFilePath);
        return res.status(200).json({ success: true, msg: "Processing completed", payload: { prompt } });
    }
    catch (error) {
        console.error("Processing failed for video file", videoFilePath, error);
        return res.status(500).json({ success: false, msg: "Processing failed" });
    }
});

module.exports = router;