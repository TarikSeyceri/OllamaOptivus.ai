const router = require("express").Router();

const multer = require("multer");
const fs = require("fs");
const path = require('path');
const mimeTypes = require('mime-types');
const { exec } = require("child_process");
const util = require("util");
const axios = require("axios");

const dataRefactory = require("./data-refactory");

const asyncExec = util.promisify(exec);

const FILE_UPLOAD_DIR = process.env.FILE_UPLOAD_DIR || "uploads";
const FILE_MAX_UPLOAD_SIZE = parseInt(process.env.FILE_MAX_UPLOAD_SIZE || 500 * 1024 * 1024); // Default 500MB
const PROCESSING_ONLY = process.env.PROCESSING_ONLY == "true";
const ALLOW_PROCESS_FILES_OUTSIDE_UPLOAD_DIR = process.env.ALLOW_PROCESS_FILES_OUTSIDE_UPLOAD_DIR == "true";
const ENABLE_PROCESS_LOCK_MECHANISM = process.env.ENABLE_PROCESS_LOCK_MECHANISM == "true";
const PYTHON_BINARY_PATH = process.env.PYTHON_BINARY_PATH || "python3";
const OLLAMA_AI_API_URL = process.env.OLLAMA_AI_API_URL || "http://host.docker.internal:11434";
const OLLAMA_AI_MODEL = process.env.OLLAMA_AI_MODEL || "deepseek-r1";
const OLLAMA_AI_TEMPERATURE = process.env.OLLAMA_AI_TEMPERATURE || 0;

var lockProcess = false;

// Ensure necessary directories exist
if (!fs.existsSync(FILE_UPLOAD_DIR)) fs.mkdirSync(FILE_UPLOAD_DIR);

// Setup multer for file uploads
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, FILE_UPLOAD_DIR);
        },
        filename: (req, file, cb) => {
            cb(null, file.originalname);
        },
    }),
    limits: { fileSize: FILE_MAX_UPLOAD_SIZE },
    fileFilter: (req, file, cb) => {
        const filePath = path.join(FILE_UPLOAD_DIR, file.originalname);

        // Check MIME type and extension
        if (path.extname(file.originalname).toLowerCase() !== ".mp4" || !["video/mp4"].includes(file.mimetype)) {
            return cb(new Error("Only .mp4 files are allowed"));
        }

        // Check if the file already exists
        if (fs.existsSync(filePath)) {
            req.existingFilePath = filePath; // Attach the existing file path to the request object
            return cb(null, false); // Reject the file upload but proceed
        }

        cb(null, true);
    },
});

// Endpoint: Upload video file
router.post("/upload", upload.single("file"), (req, res) => {
    const file = req.file;

    if (PROCESSING_ONLY) {
        console.warn("File upload disabled in this environment!");
        return res.status(403).json({ success: false, msg: "File upload disabled in this environment!" });
    }

    if (req.existingFilePath) {
        console.warn(`File already exists: ${req.existingFilePath}`);
        return res.status(200).json({ success: true, msg: "File uploaded!", payload: { filePath: req.existingFilePath } });
    }

    if (!file) {
        console.error("File not uploaded!");
        return res.status(400).json({ success: false, msg: "File not uploaded!" });
    }

    console.log("File uploaded!", file.originalname);
    return res.status(200).json({ success: true, msg: "File uploaded!", payload: { filePath: path.join(FILE_UPLOAD_DIR, file.originalname) } });
});

// Endpoint: List files
router.get("/files", (req, res) => {
    if (PROCESSING_ONLY) {
        console.warn("File listing disabled in this environment!");
        return res.status(403).json({ success: false, msg: "File listing disabled in this environment!" });
    }

    const files = fs.readdirSync(FILE_UPLOAD_DIR);
    if (files.length > 0) {
        for (let i = 0; i < files.length; i++) {
            files[i] = path.join(FILE_UPLOAD_DIR, files[i]);
        }
    }
    console.log("Files listed!", files);
    return res.status(200).json({ success: true, msg: "Files listed!", payload: { files } });
});

// Endpoint: Delete file by path
router.delete("/delete", (req, res) => {
    const { filePath } = req.query;

    if (PROCESSING_ONLY) {
        console.warn("File deletion disabled in this environment!");
        return res.status(403).json({ success: false, msg: "File deletion disabled in this environment!" });
    }

    if (!filePath) {
        console.warn("filePath not provided!");
        return res.status(400).json({ success: false, msg: "filePath not provided!" });
    }

    if (!filePath.includes(path.join(FILE_UPLOAD_DIR, path.basename(filePath)))) {
        console.warn("File path not allowed!", filePath);
        return res.status(403).json({ success: false, msg: "File path not allowed!" });
    }

    if (!fs.existsSync(filePath)) {
        console.warn("File not found!", filePath);
        return res.status(200).json({ success: true, msg: "File deleted!" });
    }

    fs.unlinkSync(filePath);
    console.log("File deleted!", filePath);
    return res.status(200).json({ success: true, msg: "File deleted successfully!" });
});

// Endpoint: Process file
router.post("/process", async (req, res) => {
    const { filePath } = req.body;

    if(lockProcess){
        console.warn("Processing already in progress!");
        return res.status(503).json({ success: false, msg: "Another processing request already in progress!, please try again later." });
    }

    if (!filePath) {
        console.warn("filePath not provided!");
        return res.status(400).json({ success: false, msg: "File path not provided!" });
    }

    if (!ALLOW_PROCESS_FILES_OUTSIDE_UPLOAD_DIR && !filePath.includes(path.join(FILE_UPLOAD_DIR, path.basename(filePath)))) {
        console.warn("File path not allowed!", filePath);
        return res.status(403).json({ success: false, msg: "File path not allowed!" });
    }

    if (!fs.existsSync(filePath)) {
        console.warn("File not found!", filePath);
        return res.status(404).json({ success: false, msg: "File not found!" });
    }

    const fileExtension = path.extname(filePath).toLowerCase(); // e.g. ".mp4"
    const fileMimeType = mimeTypes.lookup(filePath); // e.g. "video/mp4" if extension is .mp4

    if (fileExtension != '.mp4' || fileMimeType != 'video/mp4') {
        console.warn("Invalid file type!", filePath);
        return res.status(400).json({ success: false, msg: "Invalid file type!" });
    }

    // Checking if OLLAMA AI API is reachable // two URLs are checked // localhost and docker internal
    let ollamaAiApiUrl = undefined;
    try {
        const response = await axios.get(OLLAMA_AI_API_URL);
        if (response.status == 200) {
            ollamaAiApiUrl = OLLAMA_AI_API_URL;
        }
    }
    catch(error){
        ollamaAiApiUrl = undefined;
    }
    if(!ollamaAiApiUrl){
        const ollamaLocalhostAiApiUrl = "http://localhost:11434";
        try {
            const response = await axios.get(ollamaLocalhostAiApiUrl);
            if (response.status == 200) {
                ollamaAiApiUrl = ollamaLocalhostAiApiUrl;
            }
        }
        catch(error){
            ollamaAiApiUrl = undefined;
            console.error("OLLAMA AI API URL not reachable!");
            return res.status(502).json({ success: false, msg: "OLLAMA AI API URL not reachable!" });
        }
    }

    try {
        lockProcess = ENABLE_PROCESS_LOCK_MECHANISM;
        const { stdout, stderr } = await asyncExec(`${PYTHON_BINARY_PATH} ${__dirname}/processor.py ${filePath}`);
        
        if (stderr) {
            lockProcess = false;
            console.error("Processing failed for file", filePath, stderr);
            return res.status(500).json({ success: false, msg: "Processing failed" });
        }

        const jsonData = JSON.parse(stdout);
        const prompt = dataRefactory.getPrompt(jsonData);

        const response = await axios.post(ollamaAiApiUrl + "/api/generate", {
            model: OLLAMA_AI_MODEL,
            system: "Answer in english language only.",
            prompt,
            stream: false,
            options: {
                temperature: OLLAMA_AI_TEMPERATURE
            },
            "format": {
                "type": "object",
                "properties": {
                  "summary": {
                    "type": "string"
                  },
                  "isUnrespectfulConversation": {
                    "type": "boolean"
                  },
                  "customerFraud": {
                    "type": "object",
                    "properties": {
                        "percentage": {
                            "type": "number"
                        },
                        "reason": {
                            "type": "string"
                        }
                    },
                    "required": ["percentage", "reason"]
                  },
                  "customerSatisfactionPercentage": {
                    "type": "number"
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
                  "isUnrespectfulConversation",
                  "customerFraud",
                  "customerSatisfactionPercentage",
                  "events"
                ]
            }
        });

        if (response.status == 200) {
            lockProcess = false;
            console.log("Processed file", filePath);
            return res.status(200).json({ success: true, msg: "Processing completed", response: response?.data?.response });
        }
    }
    catch (error) {
        lockProcess = false;
        console.error("Processing failed for file", filePath, error);
        return res.status(500).json({ success: false, msg: "Processing failed" });
    }
});

router.post("/test", async (req, res) => {
    const filePath = "";

    // Checking if OLLAMA AI API is reachable // two URLs are checked // localhost and docker internal
    let ollamaAiApiUrl = undefined;
    try {
        const response = await axios.get(OLLAMA_AI_API_URL);
        if (response.status == 200) {
            ollamaAiApiUrl = OLLAMA_AI_API_URL;
        }
    }
    catch(error){
        ollamaAiApiUrl = undefined;
        console.warn("Provided 'OLLAMA_AI_API_URL' from environment variables could not be reached!, using localhost url", error);
    }
    if(!ollamaAiApiUrl){
        const ollamaLocalhostAiApiUrl = "http://localhost:11434";
        try {
            const response = await axios.get(ollamaLocalhostAiApiUrl);
            if (response.status == 200) {
                ollamaAiApiUrl = ollamaLocalhostAiApiUrl;
            }
        }
        catch(error){
            ollamaAiApiUrl = undefined;
            console.warn("OLLAMA Localhost AI API URL not reachable!", error);
            return res.status(502).json({ success: false, msg: "OLLAMA AI API URL not reachable!" });
        }
    }

    try {
        const { stdout, stderr } = await asyncExec(`${PYTHON_BINARY_PATH} ${__dirname}/test.py`);
        if (stderr) {
            console.error("Processing failed for file", filePath, stderr);
            return res.status(500).json({ success: false, msg: "Processing failed" });
        }

        const jsonData = JSON.parse(stdout);
        const prompt = dataRefactory.getPrompt(jsonData);

        console.log("Processed file", filePath);
        return res.status(200).json({ success: true, msg: "Processing completed", prompt });
    }
    catch (error) {
        console.error("Processing failed for file", filePath, error);
        return res.status(500).json({ success: false, msg: "Processing failed" });
    }
});

module.exports = router;