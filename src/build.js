// SPDX-License-Identifier: BSD 2-Clause License
// Copyright (c) 2025-2026, Daily

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const core = require("@actions/core");
const tar = require("tar-stream");

// Default patterns to exclude from build context
const DEFAULT_EXCLUSIONS = new Set([
  // Version control
  ".git",
  ".gitignore",
  ".gitattributes",
  // Environment and secrets
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
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
  "env",
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
  const parts = relPath.split(path.sep);
  for (const pattern of exclusions) {
    for (const part of parts) {
      if (matchesPattern(part, pattern)) return true;
    }
    if (matchesPattern(relPath, pattern)) return true;
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
 * .dockerignore takes precedence over defaults if present.
 */
function getExclusions(contextDir) {
  const dockerignore = loadDockerignore(contextDir);
  if (dockerignore !== null) return dockerignore;
  return new Set(DEFAULT_EXCLUSIONS);
}

/**
 * Recursively collect files from a directory, respecting exclusions.
 */
function collectFiles(basePath, currentPath, exclusions) {
  const results = [];
  const entries = fs.readdirSync(currentPath, { withFileTypes: true });

  // Sort for determinism
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    const relPath = path.relative(basePath, fullPath);

    if (shouldExclude(relPath, exclusions)) continue;

    if (entry.isDirectory()) {
      results.push(...collectFiles(basePath, fullPath, exclusions));
    } else if (entry.isFile()) {
      results.push({ fullPath, arcName: relPath });
    }
  }

  return results;
}

/**
 * Create a deterministic tarball from the build context directory.
 *
 * Determinism is achieved by:
 * - Sorting files alphabetically
 * - Setting mtime to Unix epoch (0)
 * - Normalizing permissions (uid=0, gid=0)
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
  const files = collectFiles(basePath, basePath, exclusions);

  // Sort by relative path for determinism
  files.sort((a, b) => a.arcName.localeCompare(b.arcName));

  // Create tar
  const pack = tar.pack();
  const chunks = [];

  const tarPromise = new Promise((resolve, reject) => {
    pack.on("data", (chunk) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });

  let totalSize = 0;
  for (const file of files) {
    const content = fs.readFileSync(file.fullPath);
    const stat = fs.statSync(file.fullPath);
    const isExecutable = (stat.mode & 0o111) !== 0;

    pack.entry(
      {
        name: file.arcName,
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

    totalSize += content.length;
  }

  pack.finalize();
  const tarBuffer = await tarPromise;

  // Check size limit
  if (totalSize > MAX_CONTEXT_SIZE) {
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Build context too large: ${sizeMB}MB (max ${MAX_CONTEXT_SIZE / (1024 * 1024)}MB)`
    );
  }

  // Gzip and zero out the mtime field (bytes 4-7) for determinism
  const gzipped = zlib.gzipSync(tarBuffer);
  gzipped[4] = gzipped[5] = gzipped[6] = gzipped[7] = 0;

  // Compute MD5 hash (first 16 hex chars to match server-side)
  const contextHash = crypto.createHash("md5").update(gzipped).digest("hex").substring(0, 16);

  core.info(
    `Build context: ${files.length} files, ${formatSize(gzipped.length)} compressed, hash=${contextHash}`
  );

  return { tarball: gzipped, contextHash, fileCount: files.length, totalSize };
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

  const response = await fetch(uploadUrl, { method: "POST", body: formData });

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
};
