// SPDX-License-Identifier: BSD 2-Clause License
// Copyright (c) 2025-2026, Daily

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PipecatCloudAPI, removeEmptyValues } from "../src/api.js";
import { startMockServer, jsonBody } from "./helpers/mock-server.js";

describe("PipecatCloudAPI", () => {
  let server;
  let handler;
  let api;

  before(async () => {
    server = await startMockServer((req) => handler(req));
    // Trailing slashes on the base URL should be stripped.
    api = new PipecatCloudAPI(`${server.url}//`, "pk_test_123");
  });

  after(() => server.close());

  beforeEach(() => {
    server.requests.length = 0;
    handler = () => undefined;
  });

  describe("checkAgent", () => {
    it("returns the agent and sends the bearer token", async () => {
      handler = () => ({ status: 200, json: { name: "my-agent" } });

      const agent = await api.checkAgent("my-agent");

      assert.deepEqual(agent, { name: "my-agent" });
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0].method, "GET");
      assert.equal(server.requests[0].path, "/v1/agents/my-agent");
      assert.equal(server.requests[0].headers.authorization, "Bearer pk_test_123");
    });

    it("URL-encodes the agent name", async () => {
      handler = () => ({ status: 200, json: {} });

      await api.checkAgent("a/b c");

      assert.equal(server.requests[0].path, "/v1/agents/a%2Fb%20c");
    });

    it("returns null on 404", async () => {
      handler = () => ({ status: 404, json: { error: "not found" } });

      assert.equal(await api.checkAgent("missing"), null);
    });

    it("throws with the API error message on other failures", async () => {
      handler = () => ({ status: 500, json: { error: "boom" } });

      await assert.rejects(api.checkAgent("x"), /Failed to check agent: boom/);
    });

    it("falls back to the status code for non-JSON error bodies", async () => {
      handler = () => ({ status: 502, text: "<html>Bad Gateway</html>" });

      await assert.rejects(api.checkAgent("x"), /Failed to check agent: HTTP 502/);
    });
  });

  describe("deploy", () => {
    const payload = { serviceName: "my-agent", image: "repo/img:v1" };

    it("POSTs to /v1/agents when creating", async () => {
      handler = () => ({ status: 200, json: { ok: true } });

      const result = await api.deploy(payload, false);

      assert.deepEqual(result, { ok: true });
      assert.equal(server.requests[0].method, "POST");
      assert.equal(server.requests[0].path, "/v1/agents");
      assert.equal(server.requests[0].headers["content-type"], "application/json");
      assert.deepEqual(jsonBody(server.requests[0]), payload);
    });

    it("POSTs to /v1/agents/{name} when updating", async () => {
      handler = () => ({ status: 200, json: {} });

      await api.deploy(payload, true);

      assert.equal(server.requests[0].path, "/v1/agents/my-agent");
    });

    it("reports create vs update in the error message", async () => {
      handler = () => ({ status: 400, json: { message: "bad image" } });

      await assert.rejects(api.deploy(payload, false), /Failed to create deployment: bad image/);
      await assert.rejects(api.deploy(payload, true), /Failed to update deployment: bad image/);
    });
  });

  it("pollForReady resolves when ready and throws on deployment errors", async () => {
    // pollForReady has a fixed 5s interval, so both cases run concurrently
    // against different agents to keep the suite fast.
    handler = (req) => {
      if (req.path === "/v1/agents/ready-agent") {
        return { status: 200, json: { ready: true, activeDeploymentReady: true } };
      }
      if (req.path === "/v1/agents/broken-agent") {
        return {
          status: 200,
          json: { errors: [{ code: "IMAGE_PULL", message: "denied" }] },
        };
      }
    };

    await Promise.all([
      api.pollForReady("ready-agent", 10).then((agent) => {
        assert.equal(agent.activeDeploymentReady, true);
      }),
      assert.rejects(
        api.pollForReady("broken-agent", 10),
        /Deployment errors: IMAGE_PULL: denied/
      ),
    ]);
  });

  describe("build endpoints", () => {
    it("buildUploadUrl sends the region only when given", async () => {
      handler = () => ({ status: 200, json: { uploadId: "u1" } });

      assert.deepEqual(await api.buildUploadUrl("us-west"), { uploadId: "u1" });
      await api.buildUploadUrl();

      assert.equal(server.requests[0].path, "/v1/builds/upload-url");
      assert.deepEqual(jsonBody(server.requests[0]), { region: "us-west" });
      assert.deepEqual(jsonBody(server.requests[1]), {});
    });

    it("buildCreate defaults dockerfilePath to Dockerfile", async () => {
      handler = () => ({ status: 200, json: { build: { id: "b1" } } });

      await api.buildCreate("u1");
      await api.buildCreate("u1", "eu", "docker/Dockerfile.prod");

      assert.deepEqual(jsonBody(server.requests[0]), {
        uploadId: "u1",
        dockerfilePath: "Dockerfile",
      });
      assert.deepEqual(jsonBody(server.requests[1]), {
        uploadId: "u1",
        dockerfilePath: "docker/Dockerfile.prod",
        region: "eu",
      });
    });

    it("buildList encodes filters as query parameters", async () => {
      handler = () => ({ status: 200, json: { builds: [] } });

      await api.buildList({
        contextHash: "abc",
        dockerfilePath: "Dockerfile",
        region: "us-west",
        status: "success",
        limit: 1,
      });

      assert.equal(server.requests[0].path, "/v1/builds");
      assert.deepEqual(server.requests[0].query, {
        contextHash: "abc",
        dockerfilePath: "Dockerfile",
        region: "us-west",
        status: "success",
        limit: "1",
      });
    });

    it("buildGet returns null on 404", async () => {
      handler = () => ({ status: 404, json: {} });

      assert.equal(await api.buildGet("nope"), null);
    });
  });

  describe("pollBuildStatus", () => {
    const fast = 0.01; // seconds between polls

    it("returns success once the build reaches a terminal status", async () => {
      const statuses = ["pending", "building", "success"];
      handler = () => ({ status: 200, json: { build: { status: statuses.shift() } } });

      const { success, build } = await api.pollBuildStatus("b1", 5, fast);

      assert.equal(success, true);
      assert.equal(build.status, "success");
      assert.equal(server.requests.length, 3);
      assert.equal(server.requests[0].path, "/v1/builds/b1");
    });

    it("returns failure for a failed build", async () => {
      handler = () => ({ status: 200, json: { status: "failed", errorMessage: "oops" } });

      const { success, build } = await api.pollBuildStatus("b1", 5, fast);

      assert.equal(success, false);
      assert.equal(build.errorMessage, "oops");
    });

    it("tolerates transient errors", async () => {
      const replies = [
        { status: 500, json: { error: "blip" } },
        { status: 503, text: "unavailable" },
        { status: 200, json: { status: "success" } },
      ];
      handler = () => replies.shift();

      const { success } = await api.pollBuildStatus("b1", 5, fast);

      assert.equal(success, true);
    });

    it("gives up after 5 consecutive errors", async () => {
      handler = () => ({ status: 500, json: { error: "down" } });

      await assert.rejects(
        api.pollBuildStatus("b1", 5, fast),
        /polling failed after 5 consecutive errors/
      );
      assert.equal(server.requests.length, 5);
    });

    it("returns failure when the build is not found", async () => {
      handler = () => ({ status: 404, json: {} });

      const { success, build } = await api.pollBuildStatus("b1", 5, fast);

      assert.equal(success, false);
      assert.equal(build.error, "Build not found");
    });

    it("times out when the build never finishes", async () => {
      handler = () => ({ status: 200, json: { status: "building" } });

      const { success, build } = await api.pollBuildStatus("b1", 0.1, fast);

      assert.equal(success, false);
      assert.equal(build.status, "timeout");
    });
  });
});

describe("removeEmptyValues", () => {
  it("drops null, undefined and empty strings, recursively", () => {
    assert.deepEqual(
      removeEmptyValues({
        a: 1,
        b: null,
        c: undefined,
        d: "",
        e: { f: undefined, g: 0 },
        h: { i: undefined },
        j: false,
        k: [1, null],
      }),
      { a: 1, e: { g: 0 }, j: false, k: [1, null] }
    );
  });
});
