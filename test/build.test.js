// SPDX-License-Identifier: BSD 2-Clause License
// Copyright (c) 2025-2026, Daily

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import tar from "tar-stream";
import { createDeterministicTarball, uploadToS3, formatSize } from "../src/build.js";
import { startMockServer } from "./helpers/mock-server.js";

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Create a temp directory populated with `files` ({ relPath: content }). */
function makeContext(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-build-test-"));
  tmpDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

/** Decompress a tarball and return its entries in archive order. */
async function readEntries(tarball) {
  const extract = tar.extract();
  const entries = [];
  const done = new Promise((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        entries.push({ ...header, content: Buffer.concat(chunks).toString("utf-8") });
        next();
      });
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
  });
  extract.end(zlib.gunzipSync(tarball));
  await done;
  return entries;
}

describe("createDeterministicTarball", () => {
  const baseFiles = {
    Dockerfile: "FROM python:3.12\n",
    "bot.py": "print('hi')\n",
    "pkg/util.py": "x = 1\n",
    "README.md": "# readme\n",
    // Excluded by default
    ".env": "SECRET=1\n",
    ".env.local": "SECRET=2\n",
    "certs/server.pem": "-----BEGIN-----\n",
    ".git/config": "[core]\n",
    "node_modules/dep/index.js": "module.exports = 1;\n",
    "pkg/__pycache__/util.cpython-312.pyc": "bytecode",
    "debug.log": "log\n",
  };

  it("includes source files sorted by path and applies default exclusions", async () => {
    const dir = makeContext(baseFiles);

    const result = await createDeterministicTarball(dir, "Dockerfile");
    const entries = await readEntries(result.tarball);

    assert.deepEqual(
      entries.map((e) => e.name),
      ["Dockerfile", "README.md", "bot.py", "pkg/util.py"]
    );
    assert.equal(result.fileCount, 4);
    assert.equal(entries.find((e) => e.name === "bot.py").content, "print('hi')\n");
  });

  it("normalizes metadata so the archive is reproducible", async () => {
    const dir = makeContext({ Dockerfile: "FROM scratch\n", "run.sh": "#!/bin/sh\n" });
    fs.chmodSync(path.join(dir, "run.sh"), 0o775);
    fs.chmodSync(path.join(dir, "Dockerfile"), 0o600);

    const { tarball } = await createDeterministicTarball(dir, "Dockerfile");
    const entries = await readEntries(tarball);

    for (const entry of entries) {
      assert.equal(entry.mtime.getTime(), 0);
      assert.equal(entry.uid, 0);
      assert.equal(entry.gid, 0);
    }
    assert.equal(entries.find((e) => e.name === "Dockerfile").mode, 0o644);
    assert.equal(entries.find((e) => e.name === "run.sh").mode, 0o755);
    // gzip header mtime is zeroed
    assert.deepEqual([...tarball.subarray(4, 8)], [0, 0, 0, 0]);
  });

  it("produces identical bytes and hash for identical content", async () => {
    const files = { Dockerfile: "FROM scratch\n", "a.py": "a\n", "z/b.py": "b\n" };
    const first = makeContext(files);
    // Same content written in reverse order with different mtimes.
    const second = makeContext(Object.fromEntries(Object.entries(files).reverse()));
    fs.utimesSync(path.join(second, "a.py"), new Date(2001, 0, 1), new Date(2001, 0, 1));

    const a = await createDeterministicTarball(first, "Dockerfile");
    const b = await createDeterministicTarball(second, "Dockerfile");

    assert.ok(a.tarball.equals(b.tarball));
    assert.equal(a.contextHash, b.contextHash);
  });

  it("derives contextHash from the first 16 hex chars of the tarball MD5", async () => {
    const dir = makeContext({ Dockerfile: "FROM scratch\n" });

    const { tarball, contextHash } = await createDeterministicTarball(dir, "Dockerfile");

    const expected = crypto.createHash("md5").update(tarball).digest("hex").slice(0, 16);
    assert.equal(contextHash, expected);
  });

  it("changes the hash when file content changes", async () => {
    const a = makeContext({ Dockerfile: "FROM scratch\n", "bot.py": "v1\n" });
    const b = makeContext({ Dockerfile: "FROM scratch\n", "bot.py": "v2\n" });

    const ha = (await createDeterministicTarball(a, "Dockerfile")).contextHash;
    const hb = (await createDeterministicTarball(b, "Dockerfile")).contextHash;

    assert.notEqual(ha, hb);
  });

  it("uses .dockerignore instead of the defaults but still excludes secrets", async () => {
    const dir = makeContext({
      ...baseFiles,
      ".dockerignore": "# comment\n*.md\nnode_modules\n.git\n",
    });

    const { tarball } = await createDeterministicTarball(dir, "Dockerfile");
    const names = (await readEntries(tarball)).map((e) => e.name);

    assert.ok(!names.includes("README.md"), "pattern from .dockerignore applied");
    assert.ok(!names.includes(".env"), ".env always excluded");
    assert.ok(!names.includes(".env.local"), ".env.* always excluded");
    assert.ok(!names.includes("certs/server.pem"), "*.pem always excluded");
    assert.ok(!names.some((n) => n.startsWith("node_modules/")));
    // Default exclusions no longer apply once a .dockerignore exists.
    assert.ok(names.includes("debug.log"));
    assert.ok(names.includes(".dockerignore"));
    assert.ok(names.includes("bot.py"));
  });

  it("supports a Dockerfile in a subdirectory", async () => {
    const dir = makeContext({ "docker/Dockerfile.prod": "FROM scratch\n", "bot.py": "" });

    const { tarball } = await createDeterministicTarball(dir, "docker/Dockerfile.prod");
    const names = (await readEntries(tarball)).map((e) => e.name);

    assert.deepEqual(names, ["bot.py", "docker/Dockerfile.prod"]);
  });

  it("throws when the context directory or Dockerfile is missing", async () => {
    const dir = makeContext({ "bot.py": "" });

    await assert.rejects(
      createDeterministicTarball(path.join(dir, "nope"), "Dockerfile"),
      /Context directory not found/
    );
    await assert.rejects(createDeterministicTarball(dir, "Dockerfile"), /Dockerfile not found/);
  });
});

describe("uploadToS3", () => {
  it("POSTs presigned fields first and the file last as multipart form data", async () => {
    const server = await startMockServer(() => ({ status: 204 }));
    try {
      const tarball = Buffer.from("fake tarball bytes");

      await uploadToS3(tarball, `${server.url}/bucket`, { key: "uploads/abc", policy: "p" });

      assert.equal(server.requests.length, 1);
      const req = server.requests[0];
      assert.equal(req.method, "POST");
      assert.equal(req.path, "/bucket");

      const form = await new Response(req.body, {
        headers: { "content-type": req.headers["content-type"] },
      }).formData();
      assert.deepEqual([...form.keys()], ["key", "policy", "Content-Type", "file"]);
      assert.equal(form.get("key"), "uploads/abc");
      assert.equal(form.get("Content-Type"), "application/gzip");
      const file = form.get("file");
      assert.equal(file.name, "context.tar.gz");
      assert.ok(Buffer.from(await file.arrayBuffer()).equals(tarball));
    } finally {
      await server.close();
    }
  });

  it("does not duplicate a presigned Content-Type field", async () => {
    const server = await startMockServer(() => ({ status: 200, text: "" }));
    try {
      await uploadToS3(Buffer.from("x"), server.url, { "Content-Type": "application/x-gzip" });

      const req = server.requests[0];
      const form = await new Response(req.body, {
        headers: { "content-type": req.headers["content-type"] },
      }).formData();
      assert.deepEqual(form.getAll("Content-Type"), ["application/x-gzip"]);
    } finally {
      await server.close();
    }
  });

  it("throws with the response body on failure", async () => {
    const server = await startMockServer(() => ({ status: 403, text: "AccessDenied" }));
    try {
      await assert.rejects(
        uploadToS3(Buffer.from("x"), server.url, {}),
        /Upload failed: HTTP 403 - AccessDenied/
      );
    } finally {
      await server.close();
    }
  });
});

describe("formatSize", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    assert.equal(formatSize(512), "512 B");
    assert.equal(formatSize(1536), "1.5 KB");
    assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
  });
});
