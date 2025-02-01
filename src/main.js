require("dotenv").config();
const express = require("express");
const expressRateLimiter = require('express-rate-limit');
const swaggerUIExpress = require('swagger-ui-express');
const path = require("path");
const fs = require("fs");
const schedule = require("node-schedule");

const { initWinston, initMorgan } = require("./loggers"); // for logging
const swaggerConfig = require('./swagger.json');

const NODE_ENV = process.env.NODE_ENV || "development";
const HTTP_PORT = process.env.HTTP_PORT || 3000;
const HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT = process.env.HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT || "100kb";
const HTTP_RATE_LIMIT_WINDOW_MS = parseInt(process.env.HTTP_RATE_LIMIT_WINDOW_MS || 1 * 60 * 1000); // 1 minute
const HTTP_RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.HTTP_RATE_LIMIT_MAX_REQUESTS || 10); // 10 requests per minute
const BEARER_TOKEN = process.env.BEARER_TOKEN || undefined; // for authentication
const FILE_UPLOAD_DIR = process.env.FILE_UPLOAD_DIR || "uploads";
const FILE_RETENTION_DAYS = parseInt(process.env.FILE_RETENTION_DAYS || 2);

const app = express();

// Logging
initWinston();         // Global Overriding console logging functions with Winston Logger
app.use(initMorgan()); // Network Logging with Morgan Logger
app.use(express.json({ limit: HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT }));

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
}
app.use(require("./api"));

// Schedule: Auto-delete old files
schedule.scheduleJob("0 * * * *", () => {
  const now = Date.now();
  fs.readdirSync(FILE_UPLOAD_DIR).forEach((file) => {
    const filePath = path.join(FILE_UPLOAD_DIR, file);
    const stats = fs.statSync(filePath);
    if (now - stats.birthtimeMs > FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      console.log("Deleted old file", filePath);
    }
  });
});

// Start server
app.listen(HTTP_PORT, () => {
  console.log(`Server running on port ${HTTP_PORT}`);
});
