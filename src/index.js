// SPDX-License-Identifier: BSD 2-Clause License
// Copyright (c) 2025-2026, Daily

const core = require("@actions/core");
const { PipecatCloudAPI, removeEmptyValues } = require("./api");
const docker = require("./docker");

async function run() {
  try {
    // ── Required inputs ────────────────────────────────────────────────
    const apiKey = core.getInput("api-key", { required: true });
    const agentName = core.getInput("agent-name", { required: true });
    const image = core.getInput("image", { required: true });

    // ── Docker build inputs ────────────────────────────────────────────
    const buildEnabled = core.getBooleanInput("build");
    const registryUsername = core.getInput("registry-username");
    const registryPassword = core.getInput("registry-password");
    const tag =
      core.getInput("tag") || process.env.GITHUB_SHA || "latest";
    const dockerfile = core.getInput("dockerfile");
    const dockerContext = core.getInput("docker-context");
    const dockerBuildArgs = core.getInput("docker-build-args");

    // ── Deploy inputs ──────────────────────────────────────────────────
    const imageCredentials = core.getInput("image-credentials");
    const secretSet = core.getInput("secret-set");
    const region = core.getInput("region");
    const minAgents = parseInt(core.getInput("min-agents"), 10);
    const maxAgents = parseInt(core.getInput("max-agents"), 10);
    const agentProfile = core.getInput("agent-profile");
    const enableManagedKeys = core.getBooleanInput("enable-managed-keys");
    const waitForReady = core.getBooleanInput("wait-for-ready");
    const waitTimeout = parseInt(core.getInput("wait-timeout"), 10);
    const apiUrl = core.getInput("api-url");

    // ── Resolve the deploy image reference ─────────────────────────────
    let deployImage;

    if (buildEnabled) {
      // Build, tag, and push the Docker image
      const imageWithTag = `${image}:${tag}`;

      core.startGroup("Docker Build & Push");

      // Login to registry if credentials are provided
      if (registryUsername && registryPassword) {
        const registry = docker.parseRegistry(image);
        await docker.login(registry, registryUsername, registryPassword);
      } else {
        core.info("No registry credentials provided, skipping docker login");
      }

      // Build the image
      await docker.build(imageWithTag, dockerfile, dockerContext, dockerBuildArgs);

      // Push the image
      await docker.push(imageWithTag);

      core.endGroup();

      deployImage = imageWithTag;
    } else {
      // When build is disabled, the image input must already include a tag
      if (!image.includes(":")) {
        throw new Error(
          'The "image" input must include a tag (e.g. my-image:v1.0) when "build" is not enabled. ' +
            'Either set build: true or provide a tagged image.'
        );
      }
      deployImage = image;
    }

    core.info(`Deploy image: ${deployImage}`);

    // ── Deploy to Pipecat Cloud ────────────────────────────────────────
    const api = new PipecatCloudAPI(apiUrl, apiKey);

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
      image: deployImage,
      imagePullSecretSet: imageCredentials || undefined,
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
    core.setOutput("image", deployImage);
    core.setOutput("service-name", agentName);

    core.info(`Deployment complete! Agent "${agentName}" deployed with image ${deployImage}`);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
