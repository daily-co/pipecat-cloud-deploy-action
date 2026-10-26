// SPDX-License-Identifier: BSD 2-Clause License
// Copyright (c) 2025-2026, Daily

// End-to-end tests: run the bundled dist/index.js (what GitHub actually
// executes) as a subprocess against a mock Pipecat Cloud API. These catch
// bundling problems and dependency regressions that the unit tests on src/
// can't, so run `npm run build` before `npm test`.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { startMockServer, jsonBody } from "./helpers/mock-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(root, "dist", "index.js");

/**
 * Read input defaults from action.yml. The runner applies these before
 * starting the action, so a subprocess run has to apply them itself.
 */
function actionDefaults() {
  const yml = fs.readFileSync(path.join(root, "action.yml"), "utf-8");
  const inputs = yml.split(/^outputs:/m)[0].split(/^inputs:/m)[1];
  const defaults = {};
  let current;
  for (const line of inputs.split("\n")) {
    const name = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (name) current = name[1];
    const def = line.match(/^ {4}default:\s*"(.*)"\s*$/);
    if (def && current) defaults[current] = def[1];
  }
  return defaults;
}

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-action-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Run the bundled action with the given inputs and return its result. */
function runAction(inputs) {
  const workDir = tmpDir();
  const outputFile = path.join(workDir, "github_output");
  fs.writeFileSync(outputFile, "");

  const env = {
    PATH: process.env.PATH,
    GITHUB_OUTPUT: outputFile,
  };
  for (const [key, value] of Object.entries({ ...actionDefaults(), ...inputs })) {
    env[`INPUT_${key.toUpperCase()}`] = value;
  }

  return new Promise((resolve) => {
    execFile(process.execPath, [distEntry], { env, cwd: workDir }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? error.code : 0,
        stdout,
        stderr,
        outputs: parseOutputs(fs.readFileSync(outputFile, "utf-8")),
      });
    });
  });
}

/** Parse the heredoc-style GITHUB_OUTPUT file written by @actions/core. */
function parseOutputs(content) {
  const outputs = {};
  const re = /^(.+?)<<(.+)\n([\s\S]*?)\n\2$/gm;
  for (const m of content.matchAll(re)) outputs[m[1]] = m[3];
  return outputs;
}

describe("action (dist/index.js)", { concurrency: true }, () => {
  before(() => {
    assert.ok(fs.existsSync(distEntry), "dist/index.js missing, run `npm run build`");
  });

  after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  // Each test gets its own mock API so tests can run concurrently (several
  // wait on the action's fixed 5s poll interval).
  async function mockApi(t, handler) {
    const server = await startMockServer(handler);
    t.after(() => server.close());
    return server;
  }

  const base = (server) => ({
    "api-key": "pk_test_123",
    "agent-name": "my-agent",
    "api-url": server.url,
    "wait-for-ready": "false",
  });

  it("creates a new agent from a pre-built image", async (t) => {
    const server = await mockApi(t, (req) => {
      if (req.method === "GET" && req.path === "/v1/agents/my-agent") {
        return { status: 404, json: { error: "not found" } };
      }
      if (req.method === "POST" && req.path === "/v1/agents") {
        return { status: 200, json: { ok: true } };
      }
    });

    const result = await runAction({
      ...base(server),
      image: "ghcr.io/org/bot:v1",
      "image-credentials": "ghcr-creds",
      "secret-set": "my-secrets",
      region: "us-west",
      "min-agents": "1",
      "max-agents": "5",
      "agent-profile": "agent-1x",
      "enable-managed-keys": "true",
      "max-session-duration": "600",
      "krisp-viva": "tel",
    });

    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(server.requests[0].headers.authorization, "Bearer pk_test_123");
    const deploy = server.requests.find((r) => r.method === "POST");
    assert.deepEqual(jsonBody(deploy), {
      serviceName: "my-agent",
      image: "ghcr.io/org/bot:v1",
      imagePullSecretSet: "ghcr-creds",
      secretSet: "my-secrets",
      region: "us-west",
      autoScaling: { minAgents: 1, maxAgents: 5 },
      enableIntegratedKeysProxy: true,
      agentProfile: "agent-1x",
      maxSessionDuration: 600,
      krispViva: { audioFilter: "tel" },
    });
    assert.deepEqual(result.outputs, { "service-name": "my-agent" });
  });

  it("updates an existing agent and omits unset optional inputs", async (t) => {
    const server = await mockApi(t, (req) => {
      if (req.method === "GET") return { status: 200, json: { name: "my-agent" } };
      if (req.method === "POST" && req.path === "/v1/agents/my-agent") {
        return { status: 200, json: {} };
      }
    });

    const result = await runAction({ ...base(server), image: "repo/bot:v2" });

    assert.equal(result.exitCode, 0, result.stdout);
    const deploy = server.requests.find((r) => r.method === "POST");
    assert.equal(deploy.path, "/v1/agents/my-agent");
    // Defaults from action.yml: min 0, max 10, managed keys off.
    assert.deepEqual(jsonBody(deploy), {
      serviceName: "my-agent",
      image: "repo/bot:v2",
      autoScaling: { minAgents: 0, maxAgents: 10 },
    });
  });

  it("runs a full cloud build, then deploys with the build ID", async (t) => {
    const context = tmpDir();
    fs.writeFileSync(path.join(context, "Dockerfile"), "FROM python:3.12\n");
    fs.writeFileSync(path.join(context, "bot.py"), "print('hi')\n");
    fs.writeFileSync(path.join(context, ".env"), "SECRET=1\n");

    let upload;
    const server = await mockApi(t, (req) => {
      if (req.method === "GET" && req.path === "/v1/builds") {
        return { status: 200, json: { builds: [] } };
      }
      if (req.path === "/v1/builds/upload-url") {
        return {
          status: 200,
          json: {
            uploadId: "up_1",
            uploadUrl: `${server.url}/s3-bucket`,
            uploadFields: { key: "ctx/up_1" },
          },
        };
      }
      if (req.path === "/s3-bucket") {
        upload = req;
        return { status: 204 };
      }
      if (req.method === "POST" && req.path === "/v1/builds") {
        return { status: 200, json: { build: { id: "build_1", status: "pending" } } };
      }
      if (req.path === "/v1/builds/build_1") {
        return {
          status: 200,
          json: { build: { id: "build_1", status: "success", buildDurationSeconds: 3 } },
        };
      }
      if (req.method === "GET" && req.path === "/v1/agents/my-agent") {
        return { status: 404, json: {} };
      }
      if (req.method === "POST" && req.path === "/v1/agents") {
        return { status: 200, json: {} };
      }
    });

    const result = await runAction({
      ...base(server),
      "cloud-build": "true",
      "build-context": context,
      region: "us-west",
    });

    assert.equal(result.exitCode, 0, result.stdout);

    const list = server.requests.find((r) => r.method === "GET" && r.path === "/v1/builds");
    assert.match(list.query.contextHash, /^[0-9a-f]{16}$/);
    assert.equal(list.query.dockerfilePath, "Dockerfile");
    assert.equal(list.query.status, "success");

    const form = await new Response(upload.body, {
      headers: { "content-type": upload.headers["content-type"] },
    }).formData();
    assert.equal(form.get("key"), "ctx/up_1", "presigned field sent to S3");
    // Uncompressed tar headers and contents are plain text.
    const tarText = zlib.gunzipSync(Buffer.from(await form.get("file").arrayBuffer())).toString();
    assert.ok(tarText.includes("print('hi')"), "bot.py uploaded");
    assert.ok(!tarText.includes("SECRET=1"), ".env must never be uploaded");

    const create = server.requests.find((r) => r.method === "POST" && r.path === "/v1/builds");
    assert.deepEqual(jsonBody(create), {
      uploadId: "up_1",
      dockerfilePath: "Dockerfile",
      region: "us-west",
    });

    const deploy = server.requests.find((r) => r.method === "POST" && r.path === "/v1/agents");
    assert.equal(jsonBody(deploy).buildId, "build_1");
    assert.equal(jsonBody(deploy).image, undefined);
    assert.deepEqual(result.outputs, { "build-id": "build_1", "service-name": "my-agent" });
  });

  it("reuses a cached build without uploading", async (t) => {
    const context = tmpDir();
    fs.writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");

    const server = await mockApi(t, (req) => {
      if (req.method === "GET" && req.path === "/v1/builds") {
        return { status: 200, json: { builds: [{ id: "build_cached" }] } };
      }
      if (req.method === "GET") return { status: 200, json: {} };
      if (req.method === "POST" && req.path === "/v1/agents/my-agent") {
        return { status: 200, json: {} };
      }
    });

    const result = await runAction({ ...base(server), "cloud-build": "true", "build-context": context });

    assert.equal(result.exitCode, 0, result.stdout);
    assert.ok(!server.requests.some((r) => r.path.startsWith("/v1/builds/upload-url")));
    const deploy = server.requests.find((r) => r.method === "POST");
    assert.equal(jsonBody(deploy).buildId, "build_cached");
    assert.equal(result.outputs["build-id"], "build_cached");
  });

  it("fails the step when the cloud build fails", async (t) => {
    const context = tmpDir();
    fs.writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");

    const server = await mockApi(t, (req) => {
      if (req.method === "GET" && req.path === "/v1/builds") {
        return { status: 200, json: { builds: [] } };
      }
      if (req.path === "/v1/builds/upload-url") {
        return {
          status: 200,
          json: { uploadId: "up_1", uploadUrl: `${server.url}/s3`, uploadFields: {} },
        };
      }
      if (req.path === "/s3") return { status: 204 };
      if (req.method === "POST" && req.path === "/v1/builds") {
        return { status: 200, json: { build: { id: "build_1" } } };
      }
      if (req.path === "/v1/builds/build_1") {
        return { status: 200, json: { status: "failed", errorMessage: "pip install failed" } };
      }
    });

    const result = await runAction({ ...base(server), "cloud-build": "true", "build-context": context });

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /::error::Cloud build failed: pip install failed/);
    assert.ok(!server.requests.some((r) => r.path.startsWith("/v1/agents")));
  });

  it("waits for the deployment to become ready", async (t) => {
    const server = await mockApi(t, (req) => {
      if (req.method === "POST") return { status: 200, json: {} };
      // First GET is the existence check, the rest are readiness polls.
      return {
        status: 200,
        json: { available: true, activeDeploymentReady: true, activeDeploymentId: "dep_1" },
      };
    });

    const result = await runAction({ ...base(server), image: "repo/bot:v1", "wait-for-ready": "true" });

    assert.equal(result.exitCode, 0, result.stdout);
    assert.match(result.stdout, /Deployment ID: dep_1/);
    assert.match(result.stdout, /Deployment is ready!/);
  });

  it("fails the step when the API rejects the deployment", async (t) => {
    const server = await mockApi(t, (req) => {
      if (req.method === "GET") return { status: 404, json: {} };
      return { status: 422, json: { error: "invalid region" } };
    });

    const result = await runAction({ ...base(server), image: "repo/bot:v1" });

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /::error::Failed to create deployment: invalid region/);
  });

  describe("input validation", { concurrency: true }, () => {
    const cases = [
      [{}, /Either "cloud-build: true", "build-id", or "image" must be provided/],
      [{ "cloud-build": "true", image: "a:b" }, /"cloud-build" and "image" are mutually exclusive/],
      [{ "cloud-build": "true", "build-id": "b1" }, /"cloud-build" and "build-id" are mutually exclusive/],
      [{ image: "no-tag" }, /must include a tag/],
      [{ "api-key": "", image: "a:b" }, /Input required and not supplied: api-key/],
    ];

    for (const [inputs, expected] of cases) {
      it(`rejects ${JSON.stringify(inputs)}`, async (t) => {
        const server = await mockApi(t, () => undefined);
        const result = await runAction({ ...base(server), ...inputs });

        assert.equal(result.exitCode, 1);
        assert.match(result.stdout, expected);
        assert.equal(server.requests.length, 0, "no API calls on invalid input");
      });
    }
  });
});
