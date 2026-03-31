// SPDX-License-Identifier: BSD 2-Clause License
// Copyright (c) 2025-2026, Daily

const core = require("@actions/core");
const { HttpClient } = require("@actions/http-client");

class PipecatCloudAPI {
  /**
   * @param {string} apiUrl - Base API URL (e.g. https://api.pipecat.daily.co)
   * @param {string} apiKey - Pipecat Cloud API key (used as Bearer token)
   */
  constructor(apiUrl, apiKey) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.client = new HttpClient("pipecat-cloud-deploy-action", [], {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Parse a JSON response body, handling errors gracefully.
   * @param {import("@actions/http-client").HttpClientResponse} response
   * @returns {{ statusCode: number, result: object }}
   */
  async _parseResponse(response) {
    const statusCode = response.message.statusCode;
    const body = await response.readBody();
    let result;

    try {
      result = JSON.parse(body);
    } catch {
      result = { rawBody: body };
    }

    return { statusCode, result };
  }

  /**
   * Extract an error message from an API response.
   * @param {object} result - Parsed response body
   * @param {number} statusCode - HTTP status code
   * @returns {string}
   */
  _errorMessage(result, statusCode) {
    return result?.error || result?.message || `HTTP ${statusCode}`;
  }

  // ── Agent endpoints ────────────────────────────────────────────────

  /**
   * Check if an agent already exists.
   * @param {string} agentName - Agent/service name
   * @returns {object|null} The agent object, or null if not found.
   */
  async checkAgent(agentName) {
    const url = `${this.apiUrl}/v1/agents/${encodeURIComponent(agentName)}`;
    core.debug(`GET ${url}`);

    const response = await this.client.get(url);
    const { statusCode, result } = await this._parseResponse(response);

    if (statusCode === 404) {
      return null;
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Failed to check agent: ${this._errorMessage(result, statusCode)}`
      );
    }

    return result;
  }

  /**
   * Deploy an agent. Uses POST /v1/agents for new agents and
   * POST /v1/agents/{name} to update an existing agent.
   * @param {object} payload - Deployment payload
   * @param {boolean} update - If true, update existing agent. Otherwise create new.
   * @returns {object} The API response body.
   */
  async deploy(payload, update) {
    let url;
    if (update) {
      url = `${this.apiUrl}/v1/agents/${encodeURIComponent(payload.serviceName)}`;
    } else {
      url = `${this.apiUrl}/v1/agents`;
    }

    core.debug(`POST ${url}`);
    core.debug(`Payload: ${JSON.stringify(payload, null, 2)}`);

    const body = JSON.stringify(payload);
    const response = await this.client.post(url, body);
    const { statusCode, result } = await this._parseResponse(response);

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Failed to ${update ? "update" : "create"} deployment: ${this._errorMessage(result, statusCode)}`
      );
    }

    return result;
  }

  /**
   * Poll until the agent deployment is ready, or until timeout.
   * @param {string} agentName - Agent/service name
   * @param {number} timeoutSeconds - Maximum seconds to wait
   */
  async pollForReady(agentName, timeoutSeconds) {
    const pollInterval = 5000; // 5 seconds
    const maxAttempts = Math.ceil((timeoutSeconds * 1000) / pollInterval);
    let activeDeploymentId = null;

    core.info(
      `Waiting for deployment to be ready (timeout: ${timeoutSeconds}s)...`
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await sleep(pollInterval);

      const agent = await this.checkAgent(agentName);

      if (!agent) {
        core.warning(
          `Agent ${agentName} not found during polling (attempt ${attempt}/${maxAttempts})`
        );
        continue;
      }

      // Track deployment ID
      if (agent.activeDeploymentId && !activeDeploymentId) {
        activeDeploymentId = agent.activeDeploymentId;
        core.info(`Deployment ID: ${activeDeploymentId}`);
      }

      // Check for errors
      if (agent.errors && agent.errors.length > 0) {
        const errorMessages = agent.errors
          .map((e) => `${e.code}: ${e.message}`)
          .join("; ");
        throw new Error(`Deployment errors: ${errorMessages}`);
      }

      // Check readiness (available + activeDeploymentReady)
      const available = agent.available === true || agent.ready === true;
      const deploymentReady = agent.activeDeploymentReady === true;

      core.info(
        `Status check ${attempt}/${maxAttempts}: available=${available}, deploymentReady=${deploymentReady}`
      );

      if (available && deploymentReady) {
        core.info("Deployment is ready!");
        return agent;
      }
    }

    throw new Error(
      `Deployment did not become ready within ${timeoutSeconds} seconds`
    );
  }

  // ── Build endpoints ────────────────────────────────────────────────

  /**
   * Get a presigned URL for uploading build context.
   * @param {string} [region] - Target region for the build
   * @returns {{ uploadId: string, uploadUrl: string, uploadFields: object, expiresAt: string }}
   */
  async buildUploadUrl(region) {
    const url = `${this.apiUrl}/v1/builds/upload-url`;
    const payload = {};
    if (region) payload.region = region;

    core.debug(`POST ${url}`);
    const response = await this.client.post(url, JSON.stringify(payload));
    const { statusCode, result } = await this._parseResponse(response);

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Failed to get upload URL: ${this._errorMessage(result, statusCode)}`
      );
    }

    return result;
  }

  /**
   * Create a new build from uploaded context.
   * @param {string} uploadId - ID from upload URL response
   * @param {string} [region] - Target region
   * @param {string} [dockerfilePath] - Dockerfile path within context
   * @returns {{ build: object, cached?: boolean }}
   */
  async buildCreate(uploadId, region, dockerfilePath) {
    const url = `${this.apiUrl}/v1/builds`;
    const payload = {
      uploadId,
      dockerfilePath: dockerfilePath || "Dockerfile",
    };
    if (region) payload.region = region;

    core.debug(`POST ${url}`);
    const response = await this.client.post(url, JSON.stringify(payload));
    const { statusCode, result } = await this._parseResponse(response);

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Failed to create build: ${this._errorMessage(result, statusCode)}`
      );
    }

    return result;
  }

  /**
   * Get build status by ID.
   * @param {string} buildId - Build ID
   * @returns {object} Build data
   */
  async buildGet(buildId) {
    const url = `${this.apiUrl}/v1/builds/${encodeURIComponent(buildId)}`;
    core.debug(`GET ${url}`);

    const response = await this.client.get(url);
    const { statusCode, result } = await this._parseResponse(response);

    if (statusCode === 404) {
      return null;
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Failed to get build status: ${this._errorMessage(result, statusCode)}`
      );
    }

    return result;
  }

  /**
   * List builds with optional filters (used for cache lookup).
   * @param {object} params - Query parameters
   * @param {string} [params.contextHash] - Filter by context hash
   * @param {string} [params.region] - Filter by region
   * @param {string} [params.status] - Filter by status
   * @param {number} [params.limit] - Max results
   * @returns {{ builds: object[], total: number }}
   */
  async buildList(params = {}) {
    const query = new URLSearchParams();
    if (params.contextHash) query.set("contextHash", params.contextHash);
    if (params.dockerfilePath) query.set("dockerfilePath", params.dockerfilePath);
    if (params.region) query.set("region", params.region);
    if (params.status) query.set("status", params.status);
    if (params.limit) query.set("limit", String(params.limit));

    const url = `${this.apiUrl}/v1/builds?${query.toString()}`;
    core.debug(`GET ${url}`);

    const response = await this.client.get(url);
    const { statusCode, result } = await this._parseResponse(response);

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Failed to list builds: ${this._errorMessage(result, statusCode)}`
      );
    }

    return result;
  }

  /**
   * Poll build status until completion or timeout.
   * Tolerates transient API errors (network blips, 500s) by retrying.
   * @param {string} buildId - Build ID to poll
   * @param {number} [maxDuration=600] - Maximum wait time in seconds
   * @param {number} [pollInterval=5] - Seconds between polls
   * @returns {{ success: boolean, build: object }}
   */
  async pollBuildStatus(buildId, maxDuration = 600, pollInterval = 5) {
    const startTime = Date.now();
    const terminalStatuses = new Set(["success", "failed", "timeout"]);
    const maxConsecutiveErrors = 5;
    let consecutiveErrors = 0;

    core.info(`Polling build status (timeout: ${maxDuration}s)...`);

    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > maxDuration) {
        return {
          success: false,
          build: { status: "timeout", error: "Build polling timeout exceeded" },
        };
      }

      await sleep(pollInterval * 1000);

      let data;
      try {
        data = await this.buildGet(buildId);
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors++;
        core.warning(
          `Build status poll failed (${consecutiveErrors}/${maxConsecutiveErrors}): ${e.message}`
        );
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(
            `Build status polling failed after ${maxConsecutiveErrors} consecutive errors: ${e.message}`
          );
        }
        continue;
      }

      if (!data) {
        return {
          success: false,
          build: { status: "error", error: "Build not found" },
        };
      }

      const build = data.build || data;
      const status = build.status || "unknown";

      core.info(`Build status: ${status} (${Math.round(elapsed)}s elapsed)`);

      if (terminalStatuses.has(status)) {
        return { success: status === "success", build };
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove keys with null or undefined values from an object, recursively.
 * Also removes empty objects left behind after removal.
 */
function removeEmptyValues(obj) {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      const nested = removeEmptyValues(value);
      if (Object.keys(nested).length > 0) {
        cleaned[key] = nested;
      }
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

module.exports = { PipecatCloudAPI, removeEmptyValues };
