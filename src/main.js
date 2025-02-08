require("dotenv").config();
const express = require("express");
const expressRateLimiter = require('express-rate-limit');
const swaggerUIExpress = require('swagger-ui-express');
const path = require("path");
const fs = require("fs");
const ollama = require('ollama').default;
const schedule = require("node-schedule");

const { initWinston, initMorgan } = require("./loggers"); // for logging
const swaggerConfig = require('./swagger.json');

const NODE_ENV = process.env.NODE_ENV || "development";
const HTTP_PORT = process.env.HTTP_PORT || 3330;
const HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT = process.env.HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT || "100kb";
const HTTP_RATE_LIMIT_WINDOW_MS = parseInt(process.env.HTTP_RATE_LIMIT_WINDOW_MS || 1 * 60 * 1000); // 1 minute
const HTTP_RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.HTTP_RATE_LIMIT_MAX_REQUESTS || 10); // 10 requests per minute
const BEARER_TOKEN = process.env.BEARER_TOKEN || undefined; // for authentication
const VIDEOS_DIR = process.env.VIDEOS_DIR || "data/videos";
const AUDIOS_DIR = process.env.AUDIOS_DIR || "data/audios";
const JSON_DATA_DIR = process.env.JSON_DATA_DIR || "data/json";
const PROMPTS_DIR = process.env.PROMPTS_DIR || "data/prompts";
const FILE_RETENTION_DAYS = parseInt(process.env.FILE_RETENTION_DAYS || 2);
const OLLAMA_AI_API_URL = process.env.OLLAMA_AI_API_URL || "http://host.docker.internal:11434";
const OLLAMA_AI_MODEL = process.env.OLLAMA_AI_MODEL || "deepseek-r1";

const app = express();

// Logging
initWinston();         // Global Overriding console logging functions with Winston Logger
app.use(initMorgan()); // Network Logging with Morgan Logger
app.use(express.json({ limit: HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT }));

if(NODE_ENV === 'development') {
  console.warn(`NODE_ENV is set to 'development', consider setting it to 'production' for better performance and security.`);
}

// Ollama Initialization
(async function(){
  ollama.config.host = OLLAMA_AI_API_URL;

  let ollamaModelsList = undefined;
  try {
    ollamaModelsList = (await ollama?.list())?.models;
  }
  catch(error){
    ollamaModelsList = undefined

    if(!OLLAMA_AI_API_URL.includes("127.0.0.1:11434")){
      console.warn(`Provided 'OLLAMA_AI_API_URL:${OLLAMA_AI_API_URL}' from environment variables could not be reached!, reason: ${error.message}, trying localhost 'http://127.0.0.1:11434' url instead.`);
    }
  }

  if(!ollamaModelsList) {
    ollama.config.host = "http://127.0.0.1:11434";

    try {
      ollamaModelsList = (await ollama?.list())?.models;
    }
    catch(error){
      console.error(`OLLAMA Localhost 'http://127.0.0.1:11434' AI API URL not reachable!, reason:`, error.message);
      process.exit(1);
    }
  }

  if(ollamaModelsList){
    console.log(`Ollama AI API is reachable at ${ollama.config.host}`);
  }

  let isModelAvailable = false;
  for(const ollamaModel of ollamaModelsList) {
    if(ollamaModel.model.includes(OLLAMA_AI_MODEL)){
      isModelAvailable = true;
      break;
    }
  }

  if(!isModelAvailable) {
    await ollama.pull(OLLAMA_AI_MODEL);

    ollamaModelsList = (await ollama?.list())?.models;

    for(const ollamaModel of ollamaModelsList) {
      if(ollamaModel.model.includes(OLLAMA_AI_MODEL)){
        isModelAvailable = true;
        break;
      }
    }

    if(!isModelAvailable) {
      console.error(`Ollama model ${OLLAMA_AI_MODEL} not available, exiting...`);
      process.exit(1);
    }
  }

  if(isModelAvailable){
    console.log(`Ollama model ${OLLAMA_AI_MODEL} is available!`);
  }
})();

if (NODE_ENV === 'production') {
  if (!BEARER_TOKEN) {
    console.error("BEARER_TOKEN is not defined in production environment.");
    process.exit(1);
  }

  // Rate Limiter Middleware
  app.use(expressRateLimiter({
    windowMs: HTTP_RATE_LIMIT_WINDOW_MS, // 1 minute
    limit: HTTP_RATE_LIMIT_MAX_REQUESTS, // limit each IP to X requests per windowMs
    handler: (req, res) => {
      return res.status(429).json({ success: false, msg: 'Too many requests sent, please try again later.' });
    }
  }));

  // Static token middleware
  app.use((req, res, next) => {
    const authHeader = req.headers["authorization"];
    if (!authHeader || authHeader !== `Bearer ${BEARER_TOKEN}`) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    next();
  });
}
else {
  // Swagger works only on Dev-Environment
  app.use('/swagger', swaggerUIExpress.serve, swaggerUIExpress.setup(swaggerConfig));
  console.log(`Swagger accessable at http://localhost:${HTTP_PORT}/swagger`);
}
app.use(require("./api"));

// Ensure necessary directories exist
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
if (!fs.existsSync(AUDIOS_DIR)) fs.mkdirSync(AUDIOS_DIR, { recursive: true });
if (!fs.existsSync(JSON_DATA_DIR)) fs.mkdirSync(JSON_DATA_DIR, { recursive: true });
if (!fs.existsSync(PROMPTS_DIR)) fs.mkdirSync(PROMPTS_DIR, { recursive: true });

// Schedule: Auto-delete old files
schedule.scheduleJob("0 * * * *", () => {
  const now = Date.now();

  fs.readdirSync(VIDEOS_DIR).forEach((file) => {
    const filePath = path.join(VIDEOS_DIR, file);
    const stats = fs.statSync(filePath);
    if (now - stats.birthtimeMs > FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      console.log("Deleted old file", filePath);
    }
  });

  fs.readdirSync(AUDIOS_DIR).forEach((file) => {
    const filePath = path.join(AUDIOS_DIR, file);
    const stats = fs.statSync(filePath);
    if (now - stats.birthtimeMs > FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      console.log("Deleted old file", filePath);
    }
  });

  fs.readdirSync(JSON_DATA_DIR).forEach((file) => {
    const filePath = path.join(JSON_DATA_DIR, file);
    const stats = fs.statSync(filePath);
    if (now - stats.birthtimeMs > FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      console.log("Deleted old file", filePath);
    }
  });

  fs.readdirSync(PROMPTS_DIR).forEach((file) => {
    const filePath = path.join(PROMPTS_DIR, file);
    const stats = fs.statSync(filePath);
    if (now - stats.birthtimeMs > FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      console.log("Deleted old file", filePath);
    }
  });
});

// Start server
app.listen(HTTP_PORT, () => {
  console.log(`Ollama Optivus Server running on port ${HTTP_PORT}`);
});
