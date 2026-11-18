import assert from "node:assert/strict";
import test from "node:test";
import { createDigitalTwinHttpServer } from "./http-server.mjs";
import { MissingProviderConfigurationError, OpenRouterError } from "./openrouter-client.mjs";
import { InMemoryRateLimiter } from "./security.mjs";
import { RequestValidationError } from "./validation.mjs";

async function startTestServer(chatService, { provider, maximumRequests = 20 } = {}) {
  const config = {
    allowedOrigins: new Set(["http://localhost:3000"]),
    trustProxy: false,
    provider: provider || { apiKey: "credential-never-return", model: "configured/test-model" },
  };
  const rateLimiter = new InMemoryRateLimiter({ maximumRequests, windowMs: 60_000 });
  const server = createDigitalTwinHttpServer({ config, chatService, rateLimiter });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

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
