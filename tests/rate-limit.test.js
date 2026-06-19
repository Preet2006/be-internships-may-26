import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  postSignal,
  startServer,
  stopServer,
  waitForServer,
} from "./helpers.js";

test("parallel burst atomically allows five requests", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signals-rate-"));
  const databaseUrl = path.join(directory, "signals.db");
  const server = startServer({
    port: 9092,
    databaseUrl,
    env: { RATE_LIMIT_PER_MIN: "5" },
  });

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitForServer(9092, server);

  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      postSignal(9092, {
        userId: "burst-user",
        type: "note",
        payload: String(index),
      }),
    ),
  );

  assert.equal(
    responses.filter(({ statusCode }) => statusCode === 200).length,
    5,
  );
  assert.equal(
    responses.filter(({ statusCode }) => statusCode === 429).length,
    15,
  );
  assert.ok(
    responses
      .filter(({ statusCode }) => statusCode === 429)
      .every(({ headers }) => Number(headers["retry-after"]) >= 1),
  );
});

test("rate limit is shared by two server instances", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "signals-multi-instance-"),
  );
  const databaseUrl = path.join(directory, "signals.db");
  const first = startServer({
    port: 9094,
    databaseUrl,
    env: { RATE_LIMIT_PER_MIN: "5" },
  });
  const second = startServer({
    port: 9095,
    databaseUrl,
    env: { RATE_LIMIT_PER_MIN: "5" },
  });

  t.after(async () => {
    await Promise.all([stopServer(first), stopServer(second)]);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all([waitForServer(9094, first), waitForServer(9095, second)]);

  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      postSignal(index % 2 === 0 ? 9094 : 9095, {
        userId: "shared-user",
        type: "note",
        payload: String(index),
      }),
    ),
  );

  assert.equal(
    responses.filter(({ statusCode }) => statusCode === 200).length,
    5,
  );
  assert.equal(
    responses.filter(({ statusCode }) => statusCode === 429).length,
    7,
  );
});
