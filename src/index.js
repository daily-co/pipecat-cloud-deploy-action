// SPDX-License-Identifier: BSD 2-Clause License
// Copyright (c) 2025-2026, Daily

const core = require("@actions/core");
const { PipecatCloudAPI, removeEmptyValues } = require("./api");
const { createDeterministicTarball, uploadToS3, formatSize } = require("./build");

async function run() {
  try {
    // ── Required inputs ────────────────────────────────────────────────
    const apiKey = core.getInput("api-key", { required: true });
    const agentName = core.getInput("agent-name", { required: true });
    // ── Cloud build inputs ─────────────────────────────────────────────
    const cloudBuildEnabled = core.getBooleanInput("cloud-build");
    const buildContext = core.getInput("build-context");
    const dockerfile = core.getInput("dockerfile");
    let buildId = core.getInput("build-id");
    const buildTimeout = parseInt(core.getInput("build-timeout"), 10) || 600;

    // ── Pre-built image inputs ─────────────────────────────────────────
    const image = core.getInput("image");
    const imageCredentials = core.getInput("image-credentials");

    // ── Deploy inputs ──────────────────────────────────────────────────
    const secretSet = core.getInput("secret-set");
    const region = core.getInput("region");
    const minAgents = parseInt(core.getInput("min-agents"), 10);
    const maxAgents = parseInt(core.getInput("max-agents"), 10);
    const agentProfile = core.getInput("agent-profile");
    const enableManagedKeys = core.getBooleanInput("enable-managed-keys");
    const waitForReady = core.getBooleanInput("wait-for-ready");
    const waitTimeout = parseInt(core.getInput("wait-timeout"), 10);
    const apiUrl = core.getInput("api-url");

    // ── Validate inputs ────────────────────────────────────────────────
    const usingCloudBuild = cloudBuildEnabled || !!buildId;

    if (!usingCloudBuild && !image) {
      throw new Error(
        'Either "cloud-build: true", "build-id", or "image" must be provided.'
      );
    }

    if (image && !image.includes(":")) {
      throw new Error(
        'The "image" input must include a tag (e.g. my-image:v1.0).'
      );
    }

    // ── Initialize API client ──────────────────────────────────────────
    const api = new PipecatCloudAPI(apiUrl, apiKey);

    // ── Cloud Build ────────────────────────────────────────────────────
    if (cloudBuildEnabled && !buildId) {
      core.startGroup("Pipecat Cloud Build");

      // Create deterministic tarball
      core.info("Creating build context...");
      const buildCtx = await createDeterministicTarball(buildContext, dockerfile);

      // Check cache
      core.info("Checking build cache...");
      try {
        const cachedBuilds = await api.buildList({
          contextHash: buildCtx.contextHash,
          region: region || undefined,
          status: "success",
          limit: 1,
        });

        if (cachedBuilds?.builds?.length > 0) {
          buildId = cachedBuilds.builds[0].id;
          core.info(`Cache hit! Reusing build: ${buildId}`);
          core.endGroup();
        }
      } catch (e) {
        core.debug(`Cache check failed (non-fatal): ${e.message}`);
      }

      if (!buildId) {
        // Get presigned upload URL
        core.info("Requesting upload URL...");
        const uploadData = await api.buildUploadUrl(region);

        // Upload context to S3
        core.info(`Uploading build context (${formatSize(buildCtx.tarball.length)})...`);
        await uploadToS3(
          buildCtx.tarball,
          uploadData.uploadUrl,
          uploadData.uploadFields
        );
        core.info("Upload complete");

        // Create build
        core.info("Starting cloud build...");
        const buildResult = await api.buildCreate(
          uploadData.uploadId,
          region,
          dockerfile
        );

        const buildData = buildResult.build || buildResult;
        buildId = buildData.id;

        // Check for server-side cache hit
        if (buildResult.cached) {
          core.info(`Server cache hit! Build ID: ${buildId}`);
        } else {
          core.info(`Build started: ${buildId}`);

          // Poll for completion
          const { success, build: finalBuild } = await api.pollBuildStatus(
            buildId,
            buildTimeout
          );

          if (!success) {
            const errorMsg =
              finalBuild.errorMessage || finalBuild.error || "Unknown error";
            throw new Error(`Cloud build failed: ${errorMsg}`);
          }

          const duration = finalBuild.buildDurationSeconds;
          core.info(
            `Build complete${duration ? ` (${duration}s)` : ""}: ${buildId}`
          );
        }

        core.endGroup();
      }
    }

    // ── Deploy to Pipecat Cloud ────────────────────────────────────────
    core.startGroup("Deploy to Pipecat Cloud");

    // Check if agent already exists
    core.info(`Checking if agent "${agentName}" already exists...`);
    const existingAgent = await api.checkAgent(agentName);
    const isUpdate = existingAgent !== null;

    if (isUpdate) {
      core.info(`Agent "${agentName}" exists — updating deployment`);
    } else {
      core.info(`Agent "${agentName}" not found — creating new deployment`);
    }

    // Build the deployment payload
    const payload = removeEmptyValues({
      serviceName: agentName,
      // Use buildId for cloud builds, image for pre-built
      ...(buildId
        ? { buildId }
        : { image, imagePullSecretSet: imageCredentials || undefined }),
      secretSet: secretSet || undefined,
      region: region || undefined,
      autoScaling: {
        minAgents: isNaN(minAgents) ? undefined : minAgents,
        maxAgents: isNaN(maxAgents) ? undefined : maxAgents,
      },
      enableIntegratedKeysProxy: enableManagedKeys || undefined,
      agentProfile: agentProfile || undefined,
    });

    // Deploy
    const result = await api.deploy(payload, isUpdate);
    core.info(
      `Deployment ${isUpdate ? "updated" : "created"} successfully`
    );
    core.debug(`Deploy response: ${JSON.stringify(result, null, 2)}`);

    core.endGroup();

    // ── Wait for readiness ─────────────────────────────────────────────
    if (waitForReady) {
      core.startGroup("Waiting for deployment readiness");
      await api.pollForReady(agentName, waitTimeout);
      core.endGroup();
    } else {
      core.info("Skipping readiness check (wait-for-ready is false)");
    }

    // ── Set outputs ────────────────────────────────────────────────────
    if (buildId) {
      core.setOutput("build-id", buildId);
    }
    core.setOutput("service-name", agentName);

    core.info(`Deployment complete! Agent "${agentName}" deployed${buildId ? ` with build ${buildId}` : ` with image ${image}`}`);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
