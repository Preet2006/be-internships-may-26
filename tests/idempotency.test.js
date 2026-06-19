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

test("parallel requests with one idempotency key return one resource", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signals-idem-"));
  const databaseUrl = path.join(directory, "signals.db");
  const server = startServer({
    port: 9091,
    databaseUrl,
    env: { RATE_LIMIT_PER_MIN: "100" },
  });

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitForServer(9091, server);

  const responses = await Promise.all(
    Array.from({ length: 20 }, () =>
      postSignal(
        9091,
        { userId: "u1", type: "note", payload: "x" },
        "same-key",
      ),
    ),
  );

  assert.ok(responses.every(({ statusCode }) => statusCode === 200));
  assert.equal(new Set(responses.map(({ body }) => body.id)).size, 1);
  assert.ok(
    responses.every(
      ({ body }) => body.idempotencyKey === "same-key" && body.payload === "x",
    ),
  );
});

test("idempotency survives a restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signals-restart-"));
  const databaseUrl = path.join(directory, "signals.db");
  const first = startServer({ port: 9093, databaseUrl });
  let second;

  t.after(async () => {
    await stopServer(first);
    if (second) await stopServer(second);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForServer(9093, first);
  const created = await postSignal(
    9093,
    { userId: "u1", type: "note", payload: "persistent" },
    "restart-key",
  );
  await stopServer(first);

  second = startServer({ port: 9093, databaseUrl });
  await waitForServer(9093, second);
  const replayed = await postSignal(
    9093,
    { userId: "u1", type: "note", payload: "persistent" },
    "restart-key",
  );

  assert.equal(replayed.statusCode, 200);
  assert.equal(replayed.body.id, created.body.id);
});
