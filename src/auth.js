const crypto = require("crypto");
const fs = require("fs");

// Tokens that were published in the repository or are obviously guessable.
const WEAK_TOKENS = new Set(["mysecrettoken", "changeme", "secret", "token", "password", "test", "admin"]);
const MIN_TOKEN_LENGTH = 32;

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest();

/**
 * Reads API tokens from HTTP_BEARER_TOKEN (comma-separated, to allow rotation) and/or the file named
 * by HTTP_BEARER_TOKEN_FILE (one token per line; Docker/Kubernetes secrets).
 */
function readTokens(env = process.env) {
    const values = [env.HTTP_BEARER_TOKEN ?? ""];
    if (env.HTTP_BEARER_TOKEN_FILE) {
        values.push(fs.readFileSync(env.HTTP_BEARER_TOKEN_FILE, "utf8"));
    }
    return values
        .join(",")
        .split(/[,\r\n]+/)
        .map((token) => token.trim())
        .filter(Boolean);
}

/** Returns human-readable problems with the configured tokens (empty array = OK). */
function tokenProblems(tokens) {
    if (tokens.length === 0) {
        return ["No API token configured. Set HTTP_BEARER_TOKEN (or HTTP_BEARER_TOKEN_FILE), e.g. to the output of `openssl rand -hex 32`."];
    }
    const problems = [];
    tokens.forEach((token, index) => {
        if (WEAK_TOKENS.has(token.toLowerCase())) {
            problems.push(`API token #${index + 1} is a publicly known default value and must be replaced.`);
        } else if (token.length < MIN_TOKEN_LENGTH) {
            problems.push(`API token #${index + 1} is too short (${token.length} chars); use at least ${MIN_TOKEN_LENGTH}.`);
        }
    });
    return problems;
}

/**
 * Bearer-token middleware. Tokens are compared as SHA-256 digests with crypto.timingSafeEqual, so
 * the comparison time does not depend on how many leading characters match.
 */
function bearerAuth(tokens, { publicPaths = [] } = {}) {
    const digests = tokens.map(sha256);
    const open = new Set(publicPaths);
    return (req, res, next) => {
        if (open.has(req.path)) return next();
        const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get("authorization") ?? "");
        if (match) {
            const candidate = sha256(match[1]);
            let valid = false;
            for (const digest of digests) {
                valid = crypto.timingSafeEqual(candidate, digest) || valid;
            }
            if (valid) return next();
        }
        res.set("WWW-Authenticate", 'Bearer realm="optivus"');
        return res.status(401).json({ success: false, msg: "Unauthorized" });
    };
}

module.exports = { readTokens, tokenProblems, bearerAuth, MIN_TOKEN_LENGTH };
