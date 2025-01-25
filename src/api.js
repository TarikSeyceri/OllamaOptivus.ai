const router = require("express").Router();

const multer = require("multer");
const fs = require("fs");
const path = require('path');
const mimeTypes = require('mime-types');
const { exec } = require("child_process");
const util = require("util");

const asyncExec = util.promisify(exec);

const FILE_UPLOAD_DIR = process.env.FILE_UPLOAD_DIR || "uploads";
const FILE_MAX_UPLOAD_SIZE = parseInt(process.env.FILE_MAX_UPLOAD_SIZE || 500 * 1024 * 1024); // Default 500MB
const PROCESS_FILES_ONLY = process.env.PROCESS_FILES_ONLY == "true";
const ALLOW_PROCESS_FILES_OUTSIDE_UPLOAD_DIR = process.env.ALLOW_PROCESS_FILES_OUTSIDE_UPLOAD_DIR == "true";

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
    if(PROCESS_FILES_ONLY){
        console.warn("File upload disabled in this environment!");
        return res.status(403).json({ success: false, msg: "File upload disabled in this environment!" });
    }

    if (req.existingFilePath) {
        console.warn(`File already exists: ${req.existingFilePath}`);
        return res.status(200).json({ success: true, msg: "File uploaded!", payload: { filePath: req.existingFilePath } });
    }

    const file = req.file;
    if (!file){
        console.error("File not uploaded!");
        return res.status(400).json({ success: false, msg: "File not uploaded!" });
    }
    
    console.log("File uploaded!", file.originalname);
    return res.status(200).json({ success: true, msg: "File uploaded!", payload: { filePath: path.join(FILE_UPLOAD_DIR, file.originalname) } });
});

// Endpoint: List files
router.get("/files", (req, res) => {
    if(PROCESS_FILES_ONLY){
        console.warn("File listing disabled in this environment!");
        return res.status(403).json({ success: false, msg: "File listing disabled in this environment!" });
    }

    const files = fs.readdirSync(FILE_UPLOAD_DIR);
    console.log("Files listed!", files);
    return res.status(200).json({ success: true, msg: "Files listed!", payload: { files } });
});

// Endpoint: Delete file by path
router.delete("/delete", (req, res) => {
    if(PROCESS_FILES_ONLY){
        console.warn("File deletion disabled in this environment!");
        return res.status(403).json({ success: false, msg: "File deletion disabled in this environment!" });
    }

    const { fileName } = req.query;
    if(!fileName){
        console.warn("File name not provided!");
        return res.status(400).json({ success: false, msg: "File name not provided!" });
    }
    const filePath = path.join(FILE_UPLOAD_DIR, fileName);

    if (!fs.existsSync(filePath)){
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

    if(!filePath){
        console.warn("filePath not provided!");
        return res.status(400).json({ success: false, msg: "File path not provided!" });
    }

    if(!ALLOW_PROCESS_FILES_OUTSIDE_UPLOAD_DIR && !filePath.includes(path.join(FILE_UPLOAD_DIR, path.basename(filePath)))){
        console.warn("File path not allowed!", filePath);
        return res.status(403).json({ success: false, msg: "File path not allowed!" });
    }

    if (!fs.existsSync(filePath)){
        console.warn("File not found!", filePath);
        return res.status(404).json({ success: false, msg: "File not found!" });
    }

    const fileExtension = path.extname(filePath).toLowerCase(); // e.g. ".mp4"
    const fileMimeType = mimeTypes.lookup(filePath); // e.g. "video/mp4" if extension is .mp4

    if (fileExtension != '.mp4' || fileMimeType != 'video/mp4') {
        console.warn("Invalid file type!", filePath);
        return res.status(400).json({ success: false, msg: "Invalid file type!" });
    }

    try {
        const { stdout, stderr } = await asyncExec(`python3 main.py ${filePath}`);
        if (stderr){
            console.error("Processing failed for file", filePath, stderr);
            return res.status(500).json({ success: false, msg: "Processing failed" });
        }

        console.log("Processed file", filePath);
        return res.status(200).json({ success: true, msg: "Processing completed", payload: { stdout } });
    } 
    catch (error) {
        console.error("Processing failed for file", filePath, error);
        return res.status(500).json({ success: false, msg: "Processing failed" });
    }
});

router.use("/api", router);
module.exports = router;