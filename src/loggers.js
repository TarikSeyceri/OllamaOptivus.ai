const winston = require("winston");
const winstonDailyRotateFile = require("winston-daily-rotate-file");
const morgan = require("morgan");
const fs = require("fs");

const LOG_DIR = process.env.LOG_DIR || "data/logs";
const LOG_LEVEL = process.env.LOG_LEVEL || "warn";
const LOG_FILE_MAX_SIZE = process.env.LOG_FILE_MAX_SIZE || "10m";
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || 30);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const winstonLogger = winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(
            ({ timestamp, level, message }) => `${timestamp} - ${level.toUpperCase()}: ${message}`
        )
    ),
    transports: [
        new winstonDailyRotateFile({
            dirname: LOG_DIR,
            filename: "node_%DATE%.log",
            datePattern: "YYYY-MM-DD",
            maxSize: LOG_FILE_MAX_SIZE,
            maxFiles: `${LOG_RETENTION_DAYS}d`,
        }),
        /*
        new winston.transports.Console({
            level: "debug",
            handleExceptions: true,
        }),
        */
    ],
    exitOnError: false,
});

const consoleColors = {
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    reset: "\x1b[0m",
};

// Backing up main console functions because we are going to override them with winston logger
const consoleLog = console.log;
const consoleInfo = console.info;
const consoleWarn = console.warn;
const consoleError = console.error;

function initWinston() {
    // Overriding console functions with winston logger
    console.log = (...messages) => {
        consoleLog(...messages);
        winstonLogger.debug(JSON.stringify(messages));
    };

    console.info = (...messages) => {
        consoleInfo(consoleColors.green, ...messages, consoleColors.reset);
        winstonLogger.info(JSON.stringify(messages));
    };

    console.warn = (...messages) => {
        consoleWarn(consoleColors.yellow, ...messages, consoleColors.reset);
        winstonLogger.warn(JSON.stringify(messages));
    };

    console.error = (...messages) => {
        consoleError(consoleColors.red, ...messages, consoleColors.reset);
        winstonLogger.error(JSON.stringify(messages));
    };
}

function initMorgan() {
    return morgan("combined", {
        stream: {
            write: (message) => {
                winstonLogger.info(message.trim());
            },
        },
    })
}

module.exports = { initWinston, initMorgan };
