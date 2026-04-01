// SPDX-License-Identifier: BSD 2-Clause License
// Copyright (c) 2025-2026, Daily

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const core = require("@actions/core");
const tar = require("tar-stream");

// Security-sensitive patterns that are always excluded, even when .dockerignore
// is present. Prevents accidental secret upload to S3.
const SECURITY_EXCLUSIONS = new Set([
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
]);

// Default patterns to exclude from build context (used when no .dockerignore)
const DEFAULT_EXCLUSIONS = new Set([
  // Security (duplicated from SECURITY_EXCLUSIONS for the no-dockerignore path)
  ...SECURITY_EXCLUSIONS,
  // Version control
  ".git",
  ".gitignore",
  ".gitattributes",
  // Python artifacts
  "__pycache__",
  "*.pyc",
  "*.pyo",
  "*.pyd",
  "*.so",
  ".Python",
  // Virtual environments
  ".venv",
  "venv",
  "ENV",
  // Testing
  ".pytest_cache",
  ".coverage",
  "htmlcov",
  ".tox",
  ".nox",
  // Type checking / Linting
  ".mypy_cache",
  ".ruff_cache",
  // IDE
  ".vscode",
  ".idea",
  "*.swp",
  "*.swo",
  // Build artifacts
  "dist",
  "build",
  "*.egg-info",
  "*.egg",
  ".eggs",
  // Node
  "node_modules",
  // CI/CD
  ".github",
  // AI tools
  ".claude",
  ".codex",
  ".cursor",
  // Pipecat config
  "pcc-deploy.toml",
  // Jupyter
  ".ipynb_checkpoints",
  // Caches
  ".cache",
  // Misc
  ".DS_Store",
  "Thumbs.db",
  "*.log",
]);

const MAX_CONTEXT_SIZE = 500 * 1024 * 1024; // 500 MB
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Compare two strings by Unicode code point order (not locale-dependent).
 * Ensures deterministic sorting regardless of runner locale.
 */
function codePointCompare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Check if a filename matches any exclusion pattern.
 * Supports simple glob patterns with * wildcard.
 */
function matchesPattern(name, pattern) {
  if (!pattern.includes("*")) {
    return name === pattern;
  }
  // Convert simple glob to regex (e.g. "*.pyc" -> /^.*\.pyc$/)
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Check if a path should be excluded from the build context.
 */
function shouldExclude(relPath, exclusions) {
  // Normalize to forward slashes for consistent matching on all platforms
  const normalized = relPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  for (const pattern of exclusions) {
    for (const part of parts) {
      if (matchesPattern(part, pattern)) return true;
    }
    if (matchesPattern(normalized, pattern)) return true;
  }
  return false;
}

/**
 * Load patterns from .dockerignore file if it exists.
 */
function loadDockerignore(contextDir) {
  const dockerignorePath = path.join(contextDir, ".dockerignore");
  if (!fs.existsSync(dockerignorePath)) return null;

  try {
    const content = fs.readFileSync(dockerignorePath, "utf-8");
    const patterns = new Set();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        patterns.add(trimmed);
      }
    }
    return patterns;
  } catch (e) {
    core.warning(`Failed to read .dockerignore: ${e.message}`);
    return null;
  }
}

/**
 * Get the set of exclusion patterns to use.
 * .dockerignore patterns are merged with security-sensitive defaults so
 * secrets are never accidentally uploaded.
 */
function getExclusions(contextDir) {
  const dockerignore = loadDockerignore(contextDir);
  if (dockerignore !== null) {
    // Merge user patterns with security-sensitive defaults
    for (const pattern of SECURITY_EXCLUSIONS) {
      dockerignore.add(pattern);
    }
    return dockerignore;
  }
  return new Set(DEFAULT_EXCLUSIONS);
}

/**
 * Recursively collect files from a directory, respecting exclusions.
 * Tracks cumulative size and aborts early if MAX_CONTEXT_SIZE is exceeded.
 */
function collectFiles(basePath, currentPath, exclusions, sizeTracker) {
  const results = [];
  const entries = fs.readdirSync(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    const relPath = path.relative(basePath, fullPath);

    if (shouldExclude(relPath, exclusions)) continue;

    if (entry.isDirectory()) {
      results.push(...collectFiles(basePath, fullPath, exclusions, sizeTracker));
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      sizeTracker.total += stat.size;
      if (sizeTracker.total > MAX_CONTEXT_SIZE) {
        const sizeMB = (sizeTracker.total / (1024 * 1024)).toFixed(1);
        throw new Error(
          `Build context too large: ${sizeMB}MB exceeds max ${MAX_CONTEXT_SIZE / (1024 * 1024)}MB. Use a .dockerignore to exclude unnecessary files.`
        );
      }
      results.push({ fullPath, arcName: relPath, size: stat.size, mode: stat.mode });
    }
  }

  return results;
}

/**
 * Create a deterministic tarball from the build context directory.
 *
 * Determinism is achieved by:
 * - Sorting files by Unicode code point order (locale-independent)
 * - Setting mtime to Unix epoch (0)
 * - Normalizing permissions (uid=0, gid=0)
 * - Normalizing path separators to forward slashes
 * - Using gzip with mtime=0
 *
 * @param {string} contextDir - Directory containing build context
 * @param {string} dockerfilePath - Path to Dockerfile relative to context
 * @returns {Promise<{tarball: Buffer, contextHash: string, fileCount: number, totalSize: number}>}
 */
async function createDeterministicTarball(contextDir, dockerfilePath) {
  const basePath = path.resolve(contextDir);

  if (!fs.existsSync(basePath)) {
    throw new Error(`Context directory not found: ${contextDir}`);
  }

  const dockerfileFullPath = path.join(basePath, dockerfilePath);
  if (!fs.existsSync(dockerfileFullPath)) {
    throw new Error(`Dockerfile not found: ${dockerfileFullPath}`);
  }

  const exclusions = getExclusions(basePath);
  const sizeTracker = { total: 0 };
  const files = collectFiles(basePath, basePath, exclusions, sizeTracker);

  // Sort by Unicode code point order for locale-independent determinism
  files.sort((a, b) => codePointCompare(a.arcName, b.arcName));

  // Create tar
  const pack = tar.pack();
  const chunks = [];

  const tarPromise = new Promise((resolve, reject) => {
    pack.on("data", (chunk) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });

  for (const file of files) {
    const content = fs.readFileSync(file.fullPath);
    const isExecutable = (file.mode & 0o111) !== 0;

    // Normalize path separators to forward slashes for cross-platform tar compat
    const tarName = file.arcName.replace(/\\/g, "/");

    pack.entry(
      {
        name: tarName,
        size: content.length,
        mtime: new Date(0),
        uid: 0,
        gid: 0,
        uname: "",
        gname: "",
        mode: isExecutable ? 0o755 : 0o644,
      },
      content
    );
  }

  pack.finalize();
  const tarBuffer = await tarPromise;

  // Gzip and zero out the mtime field (bytes 4-7) for determinism
  const gzipped = zlib.gzipSync(tarBuffer);
  gzipped[4] = gzipped[5] = gzipped[6] = gzipped[7] = 0;

  // Compute MD5 hash (first 16 hex chars).
  // This must match the server-side hash derived from the S3 ETag, so it
  // covers only the tarball content. Dockerfile-awareness is handled by
  // passing dockerfilePath as a separate filter in the cache lookup.
  const contextHash = crypto.createHash("md5").update(gzipped).digest("hex").substring(0, 16);

  core.info(
    `Build context: ${files.length} files, ${formatSize(gzipped.length)} compressed, hash=${contextHash}`
  );

  return { tarball: gzipped, contextHash, fileCount: files.length, totalSize: sizeTracker.total };
}

/**
 * Upload tarball to S3 using a presigned POST URL.
 *
 * @param {Buffer} tarball - Compressed tarball
 * @param {string} uploadUrl - Presigned S3 URL
 * @param {object} uploadFields - Fields for multipart form upload
 * @returns {Promise<void>}
 */
async function uploadToS3(tarball, uploadUrl, uploadFields) {
  const formData = new FormData();

  // Add all presigned fields first (order matters for S3)
  for (const [key, value] of Object.entries(uploadFields)) {
    formData.append(key, value);
  }

  // Add Content-Type field if not already present
  if (!uploadFields["Content-Type"]) {
    formData.append("Content-Type", "application/gzip");
  }

  // Add file last (must be named "file" for S3 presigned POST)
  formData.append("file", new Blob([tarball], { type: "application/gzip" }), "context.tar.gz");

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  if (!response.ok && response.status !== 204) {
    const body = await response.text();
    throw new Error(`Upload failed: HTTP ${response.status} - ${body}`);
  }
}

/**
 * Format byte size as human-readable string.
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
  createDeterministicTarball,
  uploadToS3,
  formatSize,
  DEFAULT_EXCLUSIONS,
  SECURITY_EXCLUSIONS,
};
