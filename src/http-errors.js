const multer = require("multer");

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** 404 for unknown routes (JSON, like every other response). */
function notFound(req, res) {
    res.status(404).json({ success: false, msg: "Not found" });
}

/**
 * Last-resort error handler. Always answers JSON, never leaks stack traces, and maps the errors of
 * body parsing and uploads to proper 4xx codes instead of a generic 500.
 */
function errorHandler(logger = console) {
    // eslint-disable-next-line no-unused-vars
    return (err, req, res, next) => {
        let status = Number.isInteger(err.status) ? err.status : 500;
        let msg = err.expose === false ? "Request failed" : err.message;

        if (err instanceof multer.MulterError) {
            status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
            msg = err.code === "LIMIT_FILE_SIZE" ? "Video file is too large." : `Invalid upload: ${err.message}`;
        } else if (err.type === "entity.parse.failed") {
            status = 400;
            msg = "Malformed JSON body.";
        } else if (err.type === "entity.too.large") {
            status = 413;
            msg = "Request body is too large.";
        }

        if (status >= 500) {
            logger.error(`Unhandled error on ${req.method} ${req.path}: ${err.stack ?? err}`);
            msg = "Internal server error";
        } else {
            logger.warn(`${req.method} ${req.path} -> ${status}: ${msg}`);
        }
        if (res.headersSent) return undefined;
        return res.status(status).json({ success: false, msg });
    };
}

module.exports = { HttpError, notFound, errorHandler };
