require("dotenv").config({ quiet: true });
const express = require("express");
const helmet = require("helmet");
const expressRateLimiter = require("express-rate-limit");
const swaggerUIExpress = require("swagger-ui-express");
const path = require("path");
const fs = require("fs");

const { initWinston, initMorgan } = require("./loggers");
const { readTokens, tokenProblems, bearerAuth } = require("./auth");
const { notFound, errorHandler } = require("./http-errors");
const { OllamaService } = require("./ollama-client");
const swaggerConfig = require("./swagger.json");

// Secure by default: anything that is not explicitly "development" runs as production.
const NODE_ENV = process.env.NODE_ENV === "development" ? "development" : "production";
const AUTH_DISABLED = process.env.AUTH_DISABLED?.toLowerCase() === "true";
const HTTP_PORT = parseInt(process.env.HTTP_PORT || 3330, 10);
const HTTP_TRUST_PROXY = process.env.HTTP_TRUST_PROXY || "false";
const HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT = process.env.HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT || "100kb";
const HTTP_RATE_LIMIT_WINDOW_MS = parseInt(process.env.HTTP_RATE_LIMIT_WINDOW_MS || 60_000, 10);
const HTTP_RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.HTTP_RATE_LIMIT_MAX_REQUESTS || 10, 10);
const HTTP_REQUEST_TIMEOUT_MS = parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS || 30 * 60_000, 10); // large uploads on slow links
const VIDEOS_DIR = process.env.VIDEOS_DIR || "data/videos";
const AUDIOS_DIR = process.env.AUDIOS_DIR || "data/audios";
const JSON_DATA_DIR = process.env.JSON_DATA_DIR || "data/json";
const PROMPTS_DIR = process.env.PROMPTS_DIR || "data/prompts";
const FILE_RETENTION_DAYS = parseFloat(process.env.FILE_RETENTION_DAYS || 2);
const OLLAMA_AI_DISABLED = process.env.OLLAMA_AI_DISABLED?.toLowerCase() === "true";

initWinston(); // console.* -> console + rotating log files

// ---------------------------------------------------------------------------
// Authentication configuration (validated before anything listens)
// ---------------------------------------------------------------------------
let tokens = [];
try {
    tokens = readTokens(process.env);
} catch (error) {
    console.error(`Cannot read HTTP_BEARER_TOKEN_FILE: ${error.message}`);
    process.exit(1);
}
if (AUTH_DISABLED) {
    if (NODE_ENV !== "development") {
        console.error("AUTH_DISABLED=true is only allowed when NODE_ENV=development. Refusing to start.");
        process.exit(1);
    }
    console.warn("Authentication is DISABLED (AUTH_DISABLED=true, development only).");
} else {
    const problems = tokenProblems(tokens);
    if (problems.length > 0) {
        problems.forEach((problem) => console.error(problem));
        console.error("Refusing to start without a strong API token (use AUTH_DISABLED=true with NODE_ENV=development for local experiments).");
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Ollama (initialized in the background; requests fail fast until it is ready)
// ---------------------------------------------------------------------------
const ollamaService = new OllamaService({
    host: process.env.OLLAMA_AI_API_URL || "http://127.0.0.1:11434",
    model: process.env.OLLAMA_AI_MODEL || "qwen3.5:4b",
    keepAlive: process.env.OLLAMA_AI_KEEP_ALIVE || "5m",
    numCtx: parseInt(process.env.OLLAMA_AI_NUM_CTX || 16384, 10),
    think: process.env.OLLAMA_AI_THINK === undefined ? false : process.env.OLLAMA_AI_THINK.toLowerCase() === "true",
    timeoutMs: parseInt(process.env.OLLAMA_AI_TIMEOUT_MS || 10 * 60_000, 10),
    logger: console,
});
if (!OLLAMA_AI_DISABLED) {
    ollamaService.init({ autoPull: process.env.OLLAMA_AI_AUTO_PULL?.toLowerCase() !== "false" })
        .catch((error) => console.error("Ollama initialization stopped:", error));
}

// ---------------------------------------------------------------------------
// HTTP application
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", HTTP_TRUST_PROXY === "true" ? true : (/^\d+$/.test(HTTP_TRUST_PROXY) ? Number(HTTP_TRUST_PROXY) : (HTTP_TRUST_PROXY === "false" ? false : HTTP_TRUST_PROXY)));
app.use(helmet({ contentSecurityPolicy: NODE_ENV === "development" ? false : undefined }));
app.use(initMorgan());
app.use(express.json({ limit: HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT }));

if (process.env.HTTP_RATE_LIMIT_ENABLED?.toLowerCase() !== "false") {
    app.use(expressRateLimiter({
        windowMs: HTTP_RATE_LIMIT_WINDOW_MS,
        limit: HTTP_RATE_LIMIT_MAX_REQUESTS,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        // Liveness/health probes (Docker, load balancers) must not consume client budgets.
        skip: (req) => req.path === "/" || req.path.startsWith("/health"),
        handler: (req, res) => res.status(429).json({ success: false, msg: "Too many requests sent, please try again later." }),
    }));
}

if (NODE_ENV === "development") {
    console.warn("NODE_ENV is 'development': Swagger UI is enabled at /swagger. Use 'production' for deployments.");
    app.use("/swagger", swaggerUIExpress.serve, swaggerUIExpress.setup(swaggerConfig));
}

if (!AUTH_DISABLED) {
    app.use(bearerAuth(tokens, { publicPaths: ["/"] }));
}

app.locals.ollama = ollamaService;
app.use(require("./api"));
app.use(notFound);
app.use(errorHandler(console));

// ---------------------------------------------------------------------------
// Storage directories and retention
// ---------------------------------------------------------------------------
for (const dir of [VIDEOS_DIR, AUDIOS_DIR, JSON_DATA_DIR, PROMPTS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
}

async function deleteExpiredFiles() {
    const maxAgeMs = FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const dir of [VIDEOS_DIR, AUDIOS_DIR, JSON_DATA_DIR, PROMPTS_DIR]) {
        let entries = [];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (error) {
            console.warn(`Retention: cannot read ${dir}: ${error.message}`);
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const filePath = path.join(dir, entry.name);
            try {
                const stats = await fs.promises.stat(filePath);
                if (now - stats.mtimeMs > maxAgeMs && !app.locals.filesInUse?.has(path.resolve(filePath))) {
                    await fs.promises.unlink(filePath);
                    console.log("Retention: deleted old file", filePath);
                }
            } catch (error) {
                console.warn(`Retention: cannot delete ${filePath}: ${error.message}`);
            }
        }
    }
}
const retentionTimer = setInterval(() => {
    deleteExpiredFiles().catch((error) => console.error("Retention sweep failed:", error));
}, 60 * 60 * 1000);
retentionTimer.unref();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = app.listen(HTTP_PORT, () => {
    console.log(`Ollama Optivus Server running on port ${HTTP_PORT} (${NODE_ENV})`);
});
server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`${signal} received, shutting down...`);
    clearInterval(retentionTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection:", reason));
