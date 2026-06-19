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

test("exhausted transient failures return 503 without a partial create", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signals-failure-"));
  const databaseUrl = path.join(directory, "signals.db");
  const failing = startServer({
    port: 9096,
    databaseUrl,
    env: {
      DB_FAIL_RATE: "1",
      DB_RETRY_ATTEMPTS: "3",
      DB_RETRY_BASE_MS: "1",
    },
  });
  let recovered;

  t.after(async () => {
    await stopServer(failing);
    if (recovered) await stopServer(recovered);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForServer(9096, failing);
  const unavailable = await postSignal(
    9096,
    { userId: "u1", type: "note", payload: "once" },
    "failure-key",
  );
  assert.equal(unavailable.statusCode, 503);
  await stopServer(failing);

  recovered = startServer({ port: 9096, databaseUrl });
  await waitForServer(9096, recovered);
  const created = await postSignal(
    9096,
    { userId: "u1", type: "note", payload: "once" },
    "failure-key",
  );
  const replayed = await postSignal(
    9096,
    { userId: "u1", type: "note", payload: "once" },
    "failure-key",
  );

  assert.equal(created.statusCode, 200);
  assert.equal(replayed.body.id, created.body.id);
});
