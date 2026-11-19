import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { createChatService } from "./chat-service.mjs";
import { createDigitalTwinHttpServer } from "./http-server.mjs";
import { createOpenRouterClient, MissingProviderConfigurationError, OpenRouterError } from "./openrouter-client.mjs";
import { InMemoryRateLimiter } from "./security.mjs";
import { REQUEST_LIMITS, RequestValidationError } from "./validation.mjs";

const allowedOrigin = "http://localhost:3000";
const chatHeaders = { "Content-Type": "application/json", Origin: allowedOrigin };
const chatBody = JSON.stringify({ messages: [{ role: "user", content: "Question" }] });

async function startTestServer(chatService, {
  provider,
  bodyTimeoutMs,
  maximumRequests = 20,
  rateLimiter = new InMemoryRateLimiter({ maximumRequests, windowMs: 60_000 }),
} = {}) {
  const config = {
    allowedOrigins: new Set([allowedOrigin]),
    trustProxy: false,
    provider: provider || { apiKey: "credential-never-return", model: "configured/test-model" },
  };
  return listen(createDigitalTwinHttpServer({ config, chatService, rateLimiter, bodyTimeoutMs }));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

function startHttpRequest(url, options, send = (request) => request.end()) {
  const request = httpRequest(url, { signal: AbortSignal.timeout(4_000), ...options });
  const response = new Promise((resolve, reject) => {
    request.once("error", reject);
    request.once("response", (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    send(request);
  });
  return { request, response };
}

function postChat(instance, headers, send) {
  return startHttpRequest(`${instance.url}/v1/chat`, {
    method: "POST",
    headers: { ...chatHeaders, ...headers },
  }, send);
}

async function checkHealth(instance) {
  const health = await fetch(`${instance.url}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
}

function notification() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function startProviderFixture(t, firstResponse, { timeoutMs, onHeaders } = {}) {
  let calls = 0;
  const upstream = await listen(createServer((request, response) => {
    request.once("end", () => {
      if (++calls === 1) {
        firstResponse(response);
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "Fixture answer" } }] }));
    });
    request.resume();
  }));
  t.after(upstream.close);

  const providerClient = createOpenRouterClient({
    apiUrl: upstream.url,
    apiKey: "fixture-key",
    model: "fixture/model",
    maxCompletionTokens: 100,
    timeoutMs,
    siteUrl: allowedOrigin,
    title: "Loopback provider fixture",
    fetchImpl: async (...args) => {
      const response = await fetch(...args);
      onHeaders?.();
      return response;
    },
  });
  const api = await startTestServer(createChatService({ providerClient }));
  t.after(api.close);
  return api;
}

async function checkChatRecovery(instance) {
  const response = await postChat(instance, {}, (request) => request.end(chatBody)).response;
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { message: { role: "assistant", content: "Fixture answer" } });
}

test("request target validation preserves valid queries and returns a sanitized 400 for invalid targets", async (t) => {
  const instance = await startTestServer({ answer: async () => assert.fail("Unexpected provider call") });
  t.after(instance.close);

  const { response } = startHttpRequest(instance.url, {
    path: "/health?check=%",
    headers: { Origin: allowedOrigin },
  });
  const rejected = await response;
  assert.equal(rejected.status, 400);
  assert.equal(rejected.headers["access-control-allow-origin"], allowedOrigin);
  assert.deepEqual(JSON.parse(rejected.body), {
    error: { code: "invalid_request_target", message: "The request target is invalid." },
  });

  const health = await fetch(`${instance.url}/health?check=ok`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");

  const absolute = await startHttpRequest(instance.url, { path: `${instance.url}/health` }).response;
  assert.equal(absolute.status, 200);
});

test("request handling contains unexpected failures before and after an await", async (t) => {
  let admissionCount = 0;
  const instance = await startTestServer({
    async answer() {
      await Promise.resolve();
      throw new Error("synthetic chat failure");
    },
  }, {
    rateLimiter: {
      consume() {
        if (++admissionCount === 1) throw new Error("synthetic admission failure");
        return { allowed: true };
      },
    },
  });
  t.after(instance.close);

  for (let i = 0; i < 2; i += 1) {
    const response = await fetch(`${instance.url}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: allowedOrigin },
      body: JSON.stringify({ messages: [{ role: "user", content: "Question" }] }),
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.deepEqual(await response.json(), {
      error: { code: "internal_error", message: "The Digital Twin encountered an unexpected error." },
    });
  }
  const health = await fetch(`${instance.url}/health`);
  assert.equal(health.status, 200);
  await health.json();
});

test("partially written responses close without sending a second response", { timeout: 5_000 }, async (t) => {
  const instance = await startTestServer({ answer: async () => { throw new Error("synthetic failure"); } });
  t.after(instance.close);
  instance.server.prependOnceListener("request", (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("fixture prefix");
  });

  const rejected = postChat(instance, {}, (request) => request.end(chatBody));
  await assert.rejects(rejected.response, { code: "ECONNRESET" });
  await checkHealth(instance);
});

test("the exact inbound byte limit succeeds with Content-Length and with chunked transfer", { timeout: 5_000 }, async (t) => {
  const body = Buffer.concat([
    Buffer.from(chatBody),
    Buffer.alloc(REQUEST_LIMITS.maximumBodyBytes - Buffer.byteLength(chatBody), " "),
  ]);
  let calls = 0;
  const instance = await startTestServer({
    async answer(messages, { signal }) {
      assert.equal(signal.aborted, false);
      assert.equal(messages[0].content, "Question");
      calls += 1;
      return { role: "assistant", content: "ok" };
    },
  });
  t.after(instance.close);

  for (const headers of [{ "Content-Length": body.length }, { "Transfer-Encoding": "chunked" }]) {
    const { response } = postChat(instance, headers, (request) => {
      request.write(body.subarray(0, 512));
      request.end(body.subarray(512));
    });
    const accepted = await response;
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.body), { message: { role: "assistant", content: "ok" } });
  }
  assert.equal(calls, 2);
});

test("oversized declared and chunked bodies receive 413 before the upload ends", { timeout: 5_000 }, async (t) => {
  let calls = 0;
  const instance = await startTestServer({ async answer() { calls += 1; } });
  t.after(instance.close);
  const oversize = REQUEST_LIMITS.maximumBodyBytes + 1;

  const declared = postChat(instance, { "Content-Length": oversize }, (request) => request.flushHeaders());
  const chunked = postChat(instance, { "Transfer-Encoding": "chunked" }, (request) => {
    request.write(Buffer.alloc(oversize, " "));
  });
  const responses = await Promise.all([declared.response, chunked.response]);
  for (const response of responses) {
    assert.equal(response.status, 413);
    assert.equal(response.headers.connection, "close");
    assert.equal(response.headers["access-control-allow-origin"], allowedOrigin);
    assert.equal(JSON.parse(response.body).error.code, "payload_too_large");
  }
  assert.equal(calls, 0);
  await checkHealth(instance);
});

test("100-continue waits for admission, and parser-rejected length headers leave the server available", { timeout: 5_000 }, async (t) => {
  let calls = 0;
  const instance = await startTestServer({
    async answer() {
      calls += 1;
      return { role: "assistant", content: "ok" };
    },
  });
  t.after(instance.close);
  let continuations = 0;
  const tooLarge = postChat(instance, {
    Expect: "100-continue", "Content-Length": REQUEST_LIMITS.maximumBodyBytes + 1,
  }, (request) => {
    request.on("continue", () => { continuations += 1; });
    request.flushHeaders();
  });
  assert.equal((await tooLarge.response).status, 413);
  assert.equal(continuations, 0);

  const valid = postChat(instance, { Expect: "100-continue", "Content-Length": Buffer.byteLength(chatBody) }, (request) => {
    request.once("continue", () => {
      continuations += 1;
      request.end(chatBody);
    });
    request.flushHeaders();
  });
  assert.equal((await valid.response).status, 200);
  assert.equal(continuations, 1);

  const invalid = await postChat(instance, { "Content-Length": "invalid" }).response;
  assert.equal(invalid.status, 400);
  assert.equal(calls, 1);
  await checkHealth(instance);
});

test("an incomplete upload receives 408 and malformed JSON preserves its 400 mapping", { timeout: 5_000 }, async (t) => {
  let calls = 0;
  const instance = await startTestServer({ async answer() { calls += 1; } }, { bodyTimeoutMs: 150 });
  t.after(instance.close);

  const stalled = await postChat(instance, { "Transfer-Encoding": "chunked" }, (request) => request.write("{")).response;
  assert.equal(stalled.status, 408);
  assert.equal(stalled.headers.connection, "close");
  assert.equal(stalled.headers["access-control-allow-origin"], allowedOrigin);
  assert.equal(JSON.parse(stalled.body).error.code, "request_body_timeout");

  const invalid = await postChat(instance, {}, (request) => request.end("{")).response;
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.body).error.code, "invalid_json");
  assert.equal(calls, 0);
  await checkHealth(instance);
});

test("disconnecting during upload skips chat and leaves the server available", { timeout: 5_000 }, async (t) => {
  const admitted = notification();
  const closed = notification();
  let calls = 0;
  const instance = await startTestServer({ async answer() { calls += 1; } }, {
    rateLimiter: { consume() { admitted.resolve(); return { allowed: true }; } },
  });
  t.after(instance.close);
  instance.server.once("request", (_request, response) => response.once("close", closed.resolve));
  const { request, response } = postChat(instance, { "Transfer-Encoding": "chunked" }, (upload) => upload.write("{"));
  const rejected = assert.rejects(response, { code: "ECONNRESET" });
  await admitted.promise;
  request.destroy();
  await rejected;
  await closed.promise;
  assert.equal(calls, 0);
  await checkHealth(instance);
});

for (const afterHeaders of [false, true]) {
  const phase = afterHeaders ? "after provider headers" : "before provider headers";

  test(`the provider deadline returns 504 ${phase} and releases the connection`, { timeout: 5_000 }, async (t) => {
    const upstreamClosed = notification();
    const api = await startProviderFixture(t, (response) => {
      response.once("close", () => upstreamClosed.resolve(response.writableFinished));
      if (afterHeaders) {
        response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "12" });
        response.write("{");
      }
    }, { timeoutMs: 250 });

    const timedOut = await postChat(api, {}, (request) => request.end(chatBody)).response;
    assert.equal(timedOut.status, 504);
    assert.equal(timedOut.headers["access-control-allow-origin"], allowedOrigin);
    assert.equal(timedOut.headers["retry-after"], undefined);
    assert.equal(JSON.parse(timedOut.body).error.code, "provider_timeout");
    assert.equal(await upstreamClosed.promise, false);
    await checkChatRecovery(api);
  });

  test(`client disconnect cancels inference ${phase}`, { timeout: 5_000 }, async (t) => {
    const receiving = notification();
    const upstreamClosed = notification();
    const api = await startProviderFixture(t, (response) => {
      response.once("close", () => upstreamClosed.resolve(response.writableFinished));
      if (afterHeaders) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write("{");
      } else {
        receiving.resolve();
      }
    }, { timeoutMs: 4_000, onHeaders: afterHeaders ? receiving.resolve : undefined });

    const { request, response } = postChat(api, {}, (upload) => upload.end(chatBody));
    const rejected = assert.rejects(response, { code: "ECONNRESET" });
    await receiving.promise;
    request.destroy();
    await rejected;
    assert.equal(await upstreamClosed.promise, false);
    await checkChatRecovery(api);
  });
}

test("an oversized provider body maps to 502 even after a rate-limit header", { timeout: 5_000 }, async (t) => {
  const upstreamClosed = notification();
  const api = await startProviderFixture(t, (response) => {
    response.once("close", () => upstreamClosed.resolve(response.writableFinished));
    response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "12" });
    response.write(Buffer.alloc(256 * 1024 + 1, " "));
  }, { timeoutMs: 2_000 });

  const rejected = await postChat(api, {}, (request) => request.end(chatBody)).response;
  assert.equal(rejected.status, 502);
  assert.equal(rejected.headers["retry-after"], undefined);
  assert.equal(JSON.parse(rejected.body).error.code, "provider_invalid_response");
  assert.equal(await upstreamClosed.promise, false);
  await checkChatRecovery(api);
});

test("allowed preflight preserves CORS response headers", { timeout: 5_000 }, async (t) => {
  const instance = await startTestServer({ answer: async () => assert.fail("Unexpected provider call") });
  t.after(instance.close);

  const response = await fetch(`${instance.url}/v1/chat`, {
    method: "OPTIONS",
    headers: { Origin: allowedOrigin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type");
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(await response.text(), "");
});

test("health endpoint reports configuration without exposing credentials", async () => {
  const instance = await startTestServer({ answer: async () => ({ role: "assistant", content: "ok" }) });
  try {
    const response = await fetch(`${instance.url}/health`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      status: "ok",
      providerConfigured: true,
      model: "configured/test-model",
    });
    assert.equal(JSON.stringify(payload).includes("credential-never-return"), false);
  } finally {
    await instance.close();
  }
});

test("health endpoint reports missing model configuration without exposing credentials", async () => {
  const instance = await startTestServer(
    { answer: async () => ({ role: "assistant", content: "ok" }) },
    { provider: { apiKey: "configured-secret", model: "" } },
  );
  try {
    const response = await fetch(`${instance.url}/health`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      status: "degraded",
      providerConfigured: false,
      model: null,
      configurationIssues: ["OPENROUTER_MODEL"],
    });
    assert.equal(JSON.stringify(payload).includes("configured-secret"), false);
  } finally {
    await instance.close();
  }
});

test("chat endpoint enforces CORS and returns a bounded response shape", async () => {
  const instance = await startTestServer({
    answer: async (messages) => ({ role: "assistant", content: `Answer for: ${messages.at(-1).content}` }),
  });

  try {
    const blocked = await fetch(`${instance.url}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Question" }] }),
    });
    assert.equal(blocked.status, 403);

    const allowed = await fetch(`${instance.url}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Question" }] }),
    });
    const payload = await allowed.json();

    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.deepEqual(payload, { message: { role: "assistant", content: "Answer for: Question" } });
  } finally {
    await instance.close();
  }
});

test("chat endpoint returns distinct sanitized configuration and provider failures", async () => {
  const cases = [
    [new MissingProviderConfigurationError(["OPENROUTER_MODEL"]), 503, "service_not_configured"],
    [new OpenRouterError("authentication", { upstreamStatus: 401, origin: "upstream_http" }), 503, "provider_configuration_error"],
    [new OpenRouterError("payment_required", { upstreamStatus: 402, origin: "upstream_http" }), 503, "provider_billing_unavailable"],
    [new OpenRouterError("model_unavailable", { upstreamStatus: 404, origin: "upstream_http" }), 503, "provider_model_unavailable"],
    [new OpenRouterError("rate_limit_exceeded", { upstreamStatus: 429, retryAfterSeconds: 12, origin: "upstream_http" }), 429, "provider_rate_limited"],
    [new OpenRouterError("timeout", { origin: "transport" }), 504, "provider_timeout"],
    [new OpenRouterError("network_error", { origin: "transport", transport: { category: "socket", causeCode: "ECONNRESET" } }), 503, "provider_connection_error"],
    [new OpenRouterError("invalid_provider_response", { upstreamStatus: 200, origin: "upstream_http" }), 502, "provider_invalid_response"],
    [new OpenRouterError("truncated_provider_response", { upstreamStatus: 200, origin: "upstream_payload" }), 502, "provider_response_truncated"],
    [new OpenRouterError("reasoning_only_response", { upstreamStatus: 200, origin: "upstream_payload" }), 502, "provider_reasoning_only"],
    [new OpenRouterError("unsupported_provider_response", { upstreamStatus: 200, origin: "upstream_payload" }), 502, "provider_unsupported_response"],
    [new OpenRouterError("provider_unavailable", { upstreamStatus: 502, origin: "upstream_http" }), 502, "provider_bad_gateway"],
    [new OpenRouterError("request_construction_error", { origin: "local_request" }), 500, "provider_request_construction_error"],
  ];

  for (const [providerError, expectedStatus, expectedCode] of cases) {
    const instance = await startTestServer({ answer: async () => { throw providerError; } });
    try {
      const response = await fetch(`${instance.url}/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Question" }] }),
      });
      const payload = await response.json();
      assert.equal(response.status, expectedStatus);
      assert.equal(payload.error.code, expectedCode);
      if (providerError.retryAfterSeconds) {
        assert.equal(response.headers.get("retry-after"), String(providerError.retryAfterSeconds));
      }
      assert.equal(JSON.stringify(payload).includes("OPENROUTER_MODEL"), false);
    } finally {
      await instance.close();
    }
  }
});

test("chat endpoint rejects invalid requests and enforces local rate limiting", async () => {
  const instance = await startTestServer(
    {
      answer: async (messages) => {
        if (!Array.isArray(messages) || messages.length === 0) {
          throw new RequestValidationError("At least one conversation message is required.");
        }
        return { role: "assistant", content: "ok" };
      },
    },
    { maximumRequests: 1 },
  );
  try {
    const invalid = await fetch(`${instance.url}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(invalid.status, 400);

    const limited = await fetch(`${instance.url}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Question" }] }),
    });
    const payload = await limited.json();
    assert.equal(limited.status, 429);
    assert.equal(payload.error.code, "rate_limited");
  } finally {
    await instance.close();
  }
});
