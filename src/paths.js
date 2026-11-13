const fs = require("fs");
const path = require("path");

/** True when `child` is `root` itself or inside it (both absolute, already normalized). */
function isInside(root, child) {
    const relative = path.relative(root, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathOrSelf(p) {
    try {
        return await fs.promises.realpath(p);
    } catch {
        return path.resolve(p);
    }
}

/** Accepts both "data/videos/x.mp4" and Windows-style "data\\videos\\x.mp4" on every platform. */
function normalizeClientPath(input) {
    return path.sep === "/" ? input.replace(/\\/g, "/") : input;
}

/**
 * Resolves a client-supplied path and checks that it stays inside one of `roots`.
 * The check is done twice: lexically (so "outside" wins over "missing", as in v1) and again after
 * resolving symlinks with realpath (so a symlink inside a root cannot point outside of it).
 *
 * @returns {Promise<{ path: string } | { error: "forbidden" | "not_found" }>}
 */
async function resolveInsideRoots(input, roots) {
    const absolute = path.resolve(normalizeClientPath(input));
    const resolvedRoots = await Promise.all(roots.map(realpathOrSelf));
    const lexicalRoots = roots.map((root) => path.resolve(root));

    if (!lexicalRoots.some((root) => isInside(root, absolute)) && !resolvedRoots.some((root) => isInside(root, absolute))) {
        return { error: "forbidden" };
    }

    let real;
    try {
        real = await fs.promises.realpath(absolute);
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return { error: "not_found" };
        throw error;
    }
    if (!resolvedRoots.some((root) => isInside(root, real))) {
        return { error: "forbidden" };
    }
    return { path: real };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Turns a client-supplied upload name into a safe file name: no directories, no control or shell
 * characters, bounded length, lower-case extension. Returns null when nothing usable is left.
 */
function sanitizeFileName(original, { maxLength = 120 } = {}) {
    const base = String(original ?? "").split(/[\\/]/).pop().normalize("NFC");
    const ext = path.extname(base).toLowerCase();
    let stem = path.basename(base, path.extname(base))
        .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
        .replace(/\s+/g, " ")
        .replace(/^[.\s_-]+|[.\s]+$/g, "");
    if (!stem || WINDOWS_RESERVED.test(stem)) return null;
    stem = stem.slice(0, Math.max(1, maxLength - ext.length));
    return stem + ext;
}

module.exports = { isInside, resolveInsideRoots, sanitizeFileName, normalizeClientPath };
