// SPDX-License-Identifier: BSD 2-Clause License
// Copyright (c) 2025-2026, Daily

import http from "http";

/**
 * Start a local HTTP server that stands in for the Pipecat Cloud API (and S3).
 *
 * `handler(req)` receives `{ method, path, query, headers, body }` and returns
 * `{ status, json }` or `{ status, text }`. Every request is recorded in
 * `server.requests` so tests can assert on what the action sent.
 */
export async function startMockServer(handler) {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const url = new URL(req.url, "http://localhost");
    const recorded = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    };
    requests.push(recorded);

    let reply;
    try {
      reply = (await handler(recorded)) || { status: 404, json: { error: "not mocked" } };
    } catch (e) {
      reply = { status: 500, json: { error: `mock handler threw: ${e.message}` } };
    }

    if (reply.json !== undefined) {
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.json));
    } else {
      res.writeHead(reply.status);
      res.end(reply.text ?? "");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Parse a recorded request body as JSON. */
export function jsonBody(request) {
  return JSON.parse(request.body.toString("utf-8"));
}
