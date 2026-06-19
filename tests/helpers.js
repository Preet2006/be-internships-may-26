import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as wait } from "node:timers/promises";

export function startServer({ port, databaseUrl, env = {} }) {
  const child = spawn("node", ["src/server.js"], {
    env: {
      ...process.env,
      API_KEY: "test-key",
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      DB_FAIL_RATE: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  return {
    child,
    getOutput: () => output,
  };
}

export async function waitForServer(port, server, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      assert.fail(`server exited during startup:\n${server.getOutput()}`);
    }

    try {
      const response = await request({
        port,
        path: "/healthz",
        method: "GET",
      });
      if (response.statusCode === 200) return;
    } catch {
      // The socket is not listening yet.
    }
    await wait(50);
  }

  assert.fail(`server did not become ready:\n${server.getOutput()}`);
}

export async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill();
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    wait(2_000),
  ]);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}

export async function postSignal(port, body, idempotencyKey) {
  return request({
    port,
    path: "/v1/signals",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "test-key",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body,
  });
}

export function request({ port, path, method, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const encodedBody =
      typeof body === "undefined" ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...headers,
          ...(encodedBody
            ? { "content-length": Buffer.byteLength(encodedBody) }
            : {}),
        },
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          chunks += chunk;
        });
        res.on("end", () => {
          let json = {};
          if (chunks) {
            try {
              json = JSON.parse(chunks);
            } catch {
              return reject(new Error(`invalid JSON response: ${chunks}`));
            }
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: json,
          });
        });
      },
    );
    req.on("error", reject);
    if (encodedBody) req.write(encodedBody);
    req.end();
  });
}
