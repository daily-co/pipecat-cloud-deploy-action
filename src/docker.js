// SPDX-License-Identifier: BSD 2-Clause License
// Copyright (c) 2025-2026, Daily

const core = require("@actions/core");
const exec = require("@actions/exec");

/**
 * Parse the registry hostname from a full image name.
 * e.g. "ghcr.io/my-org/my-bot" => "ghcr.io"
 * e.g. "my-org/my-bot" => "docker.io" (Docker Hub default)
 *
 * @param {string} image - Full image name without tag
 * @returns {string} The registry hostname
 */
function parseRegistry(image) {
  const parts = image.split("/");

  // If the first part contains a dot or colon, it's a registry hostname.
  // e.g. "ghcr.io", "registry.example.com", "localhost:5000"
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":"))) {
    return parts[0];
  }

  // Otherwise it's Docker Hub
  return "docker.io";
}

/**
 * Log in to a Docker registry.
 *
 * @param {string} registry - Registry hostname
 * @param {string} username - Registry username
 * @param {string} password - Registry password or token
 */
async function login(registry, username, password) {
  core.info(`Logging in to ${registry}...`);

  await exec.exec("docker", ["login", registry, "-u", username, "--password-stdin"], {
    input: Buffer.from(password),
  });

  core.info(`Successfully logged in to ${registry}`);
}

/**
 * Build a Docker image.
 *
 * @param {string} imageWithTag - Full image reference including tag (e.g. ghcr.io/org/bot:abc123)
 * @param {string} dockerfile - Path to the Dockerfile
 * @param {string} context - Docker build context path
 * @param {string} buildArgsStr - Newline-separated build args (e.g. "ARG1=val1\nARG2=val2")
 */
async function build(imageWithTag, dockerfile, context, buildArgsStr) {
  core.info(`Building Docker image: ${imageWithTag}`);

  const args = ["build", "-t", imageWithTag, "-f", dockerfile];

  // Parse and add build args
  if (buildArgsStr) {
    const buildArgs = buildArgsStr
      .split("\n")
      .map((arg) => arg.trim())
      .filter((arg) => arg.length > 0);

    for (const arg of buildArgs) {
      args.push("--build-arg", arg);
    }
  }

  args.push(context);

  await exec.exec("docker", args);

  core.info(`Successfully built ${imageWithTag}`);
}

/**
 * Push a Docker image to its registry.
 *
 * @param {string} imageWithTag - Full image reference including tag
 */
async function push(imageWithTag) {
  core.info(`Pushing Docker image: ${imageWithTag}`);

  await exec.exec("docker", ["push", imageWithTag]);

  core.info(`Successfully pushed ${imageWithTag}`);
}

module.exports = { parseRegistry, login, build, push };
