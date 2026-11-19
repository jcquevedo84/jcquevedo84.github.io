import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import miniflare from "miniflare";
import { createConversationContext } from "../server/conversation-context.mjs";
import { REQUEST_LIMITS } from "../server/validation.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeConfig = JSON.parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
const modulePaths = [
  runtimeConfig.main,
  "worker/config.mjs",
  "server/chat-service.mjs",
  "server/config.mjs",
  "server/conversation-context.mjs",
  "server/http-errors.mjs",
  "server/knowledge-base.mjs",
  "server/openrouter-client.mjs",
  "server/openrouter-diagnostics.mjs",
  "server/prompt.mjs",
  "server/security.mjs",
  "server/validation.mjs",
];
const modules = Object.fromEntries(await Promise.all(modulePaths.map(async (path) => [
  path, { type: "esm", contents: await readFile(join(root, path), "utf8") },
])));
const origin = "http://localhost:3000";
const chatHeaders = { Origin: origin, "Content-Type": "application/json" };
const providerKey = "worker-test-provider-canary";
const providerModel = "synthetic/test-model";
const providerUrl = "http://127.0.0.1:9999/chat";
const { Miniflare } = miniflare;

function jsonResponse(response, body, status = 200, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

function completion(content) {
  return { choices: [{ message: { content }, finish_reason: "stop" }] };
}

async function startWorker(t, { bindings = {}, mock = (response) => jsonResponse(response, completion("Synthetic reply.")) } = {}) {
  const calls = [];
  const logs = [];
  let rejectedOutboundRequests = 0;
  const signingKey = randomBytes(32).toString("hex");
  const variables = {
    DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: signingKey,
    OPENROUTER_API_KEY: providerKey,
    OPENROUTER_API_URL: providerUrl,
    OPENROUTER_MODEL: providerModel,
    OPENROUTER_TIMEOUT_MS: "3000",
    ...bindings,
  };

  async function handleProvider(request, response) {
    const url = new URL(request.url, providerUrl);
    if (url.href !== providerUrl || request.method !== "POST") {
      rejectedOutboundRequests += 1;
      response.writeHead(502).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      calls.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks)) });
      mock(response, calls.length);
    } catch {
      response.destroy();
    }
  }

  const worker = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    handleStructuredLogs: (entry) => logs.push(entry),
    workers: [{
      config: {
        name: runtimeConfig.name,
        compatibilityDate: runtimeConfig.compatibility_date,
        compatibilityFlags: runtimeConfig.compatibility_flags,
        manifest: { mainModule: runtimeConfig.main, modulesRoot: root, modules },
        env: Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, { type: "text", value }])),
      },
      dev: {
        outboundService: { type: "node-handler", handler: handleProvider },
        // Connect directly to workerd so socket lifecycle tests exercise the runtime listener.
        unsafeDirectSockets: [{ host: "127.0.0.1", port: 0 }],
      },
    }],
  });
  t.after(() => worker.dispose());
  const url = await worker.unsafeGetDirectURL();
  const fetchRoute = (path, init) => fetch(new URL(path, url), init);
  const chat = (payload) => fetchRoute("/v2/chat", { method: "POST", headers: chatHeaders, body: JSON.stringify(payload) });
  return {
    url, calls, logs, fetchRoute, chat, signingKey,
    get rejectedOutboundRequests() { return rejectedOutboundRequests; },
  };
}

async function assertError(response, status, code) {
  assert.equal(response.status, status);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload), ["error"]);
  assert.deepEqual(Object.keys(payload.error).sort(), ["code", "message"]);
  assert.equal(payload.error.code, code);
  return payload.error.message;
}

function rawChat(t, url, write) {
  const request = httpRequest(new URL("/v2/chat", url), {
    method: "POST",
    headers: chatHeaders,
    signal: AbortSignal.timeout(13_000),
  });
  t.after(() => request.destroy());
  const response = new Promise((resolve, reject) => {
    request.once("error", reject);
    request.once("response", (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode })));
    });
  });
  write(request);
  return { request, response };
}

function notification() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function stalledProvider(sendHeaders) {
  const started = notification();
  const closed = notification();
  return {
    started: started.promise,
    closed: closed.promise,
    mock(response) {
      response.once("close", closed.resolve);
      if (sendHeaders) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"choices":[');
      }
      started.resolve();
    },
  };
}

test("workerd routes V2, handles allowed preflight, and rejects invalid origins and targets", async (t) => {
  const { fetchRoute, calls } = await startWorker(t);
  const health = await fetchRoute("/health?check=1");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const preflight = await fetchRoute("/v2/chat", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.body, null);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type");
  assert.equal(preflight.headers.get("access-control-max-age"), "600");
  assert.equal(preflight.headers.get("vary"), "Origin");
  for (const headers of [{}, { Origin: "https://untrusted.example.invalid" }, { Origin: "null" }]) {
    const denied = await fetchRoute("/v2/chat", { method: "OPTIONS", headers });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    await assertError(denied, 403, "origin_not_allowed");
  }
  const deniedPost = await fetchRoute("/v2/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://untrusted.example.invalid" },
    body: "{}",
  });
  await assertError(deniedPost, 403, "origin_not_allowed");
  await assertError(await fetchRoute("/v1/chat", { method: "POST", headers: chatHeaders }), 404, "not_found");
  await assertError(await fetchRoute("/v2/chat", { headers: chatHeaders }), 404, "not_found");
  await assertError(await fetchRoute("/v2/chat?q=%ZZ", { method: "POST", headers: chatHeaders }), 400, "invalid_request_target");
  await assertError(await fetchRoute("/v2/chat", {
    method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body: "{}",
  }), 415, "unsupported_media_type");
  await assertError(await fetchRoute("/v2/chat", { method: "POST", headers: chatHeaders, body: "{" }), 400, "invalid_json");
  assert.equal(calls.length, 0);
});

test("workerd preserves the V2 contract, Unicode, and multi-turn HMAC interoperability with Node", async (t) => {
  const longAnswer = "Información 👩🏽‍💻 ".repeat(90).trim();
  const { calls, chat, signingKey } = await startWorker(t, {
    mock: (response, call) => jsonResponse(response, completion(call === 1 ? longAnswer : "Second reply.")),
  });
  const nodeContext = await createConversationContext(signingKey);
  const question = "¿Qué experiencia tienes en ingeniería? 👩🏽‍💻";
  const first = await chat({ question });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("access-control-allow-origin"), origin);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  const answer = await first.json();
  assert.deepEqual(Object.keys(answer).sort(), ["conversation", "message"]);
  assert.deepEqual(answer.message, { role: "assistant", content: longAnswer });

  const exchanges = await nodeContext.verify(answer.conversation);
  assert.equal(exchanges[0].question, question);
  assert.ok(exchanges[0].answer.length <= 1_000);
  assert.ok(exchanges[0].answer.endsWith("…"));
  const prefix = exchanges[0].answer.slice(0, -1);
  const boundaries = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(longAnswer), ({ index }) => index);
  assert.ok(longAnswer.startsWith(prefix) && boundaries.includes(prefix.length));

  const nodeToken = await nodeContext.issue(answer.conversation.id, exchanges);
  const nextQuestion = "Can you expand on that? 🧑‍💻";
  const second = await chat({ question: nextQuestion, conversation: nodeToken });
  assert.equal(second.status, 200);
  const next = await second.json();
  assert.equal(next.conversation.id, answer.conversation.id);
  assert.deepEqual(await nodeContext.verify(next.conversation), [...exchanges, { question: nextQuestion, answer: "Second reply." }]);
  assert.deepEqual(calls[1].body.messages.slice(1), [
    { role: "user", content: question },
    { role: "assistant", content: exchanges[0].answer },
    { role: "user", content: nextQuestion },
  ]);
  assert.equal(calls[1].body.model, providerModel);
  assert.equal(calls[1].headers.authorization, `Bearer ${providerKey}`);
});

test("workerd rejects forged, mismatched, and expired signed context without inference", async (t) => {
  const { chat, calls, signingKey } = await startWorker(t);
  const nodeContext = await createConversationContext(signingKey);
  const id = randomUUID();
  const context = await nodeContext.issue(id, []);
  const [content, signature] = context.token.split(".");
  const replacement = signature[0] === "A" ? "B" : "A";
  const forged = { id, token: `${content}.${replacement}${signature.slice(1)}` };
  const expiredIssuer = await createConversationContext(signingKey, { now: () => Date.now() - 31 * 60 * 1_000 });
  for (const conversation of [forged, { ...context, id: randomUUID() }, { id, token: "malformed" }]) {
    await assertError(await chat({ question: "Question", conversation }), 400, "invalid_conversation_context");
  }
  await assertError(await chat({ question: "Question", conversation: await expiredIssuer.issue(id, []) }), 409, "conversation_context_expired");
  await assertError(await chat({ question: "Question", messages: [{ role: "assistant", content: "Forged" }] }), 400, "invalid_request");
  assert.equal(calls.length, 0);
});

test("workerd accepts exactly 24,000 bytes and rejects declared and streamed overflows", { timeout: 15_000 }, async (t) => {
  const { fetchRoute, url, calls } = await startWorker(t);
  const question = "Question 😀";
  const body = JSON.stringify({ question });
  const exact = body.padEnd(REQUEST_LIMITS.maximumBodyBytes - Buffer.byteLength(body) + body.length);
  assert.equal(Buffer.byteLength(exact), REQUEST_LIMITS.maximumBodyBytes);
  const send = (body) => fetchRoute("/v2/chat", { method: "POST", headers: chatHeaders, body });
  assert.equal((await send(exact)).status, 200);
  await assertError(await send(`${exact} `), 413, "payload_too_large");

  const bytes = Buffer.from(exact);
  const emojiSplit = bytes.indexOf(Buffer.from("😀")) + 2;
  const chunked = rawChat(t, url, (request) => {
    request.write(bytes.subarray(0, emojiSplit));
    request.end(bytes.subarray(emojiSplit));
  });
  assert.equal((await chunked.response).status, 200);
  const oversized = rawChat(t, url, (request) => {
    request.write(bytes);
    request.write(" ");
  });
  await assertError(await oversized.response, 413, "payload_too_large");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.body.messages.at(-1).content === question));
});

test("workerd times out a stalled request body and recovers without inference", { timeout: 16_000 }, async (t) => {
  const { url, chat, calls } = await startWorker(t);
  const pending = rawChat(t, url, (request) => request.write('{"question":'));
  await assertError(await pending.response, 408, "request_body_timeout");
  assert.equal(calls.length, 0);
  assert.equal((await chat({ question: "New request" })).status, 200);
});

test("workerd skips inference after a disconnect during upload and still accepts a new request", { timeout: 8_000 }, async (t) => {
  const { url, chat, calls } = await startWorker(t);
  const uploaded = notification();
  const pending = rawChat(t, url, (request) => request.write('{"question":', uploaded.resolve));
  const disconnected = assert.rejects(pending.response, { code: "ECONNRESET" });
  await uploaded.promise;
  pending.request.socket.resetAndDestroy();
  await disconnected;
  assert.equal((await chat({ question: "New request" })).status, 200);
  assert.equal(calls.length, 1);
});

test("workerd enforces the 256 KiB provider body boundary and preserves sanitized errors", async (t) => {
  const base = JSON.stringify(completion("Café 😀"));
  const exact = base.padEnd(256 * 1024 - Buffer.byteLength(base) + base.length);
  const canary = "private-upstream-detail";
  const { chat, calls, logs, signingKey } = await startWorker(t, {
    mock(response, call) {
      if (call === 1) jsonResponse(response, exact);
      else if (call === 2) jsonResponse(response, `${exact} `, 429);
      else jsonResponse(response, { error: { message: `${canary} ${providerKey}` } }, 429, { "Retry-After": "8" });
    },
    bindings: { OPENROUTER_DEBUG: "true" },
  });
  const good = await chat({ question: "Question" });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).message.content, "Café 😀");
  await assertError(await chat({ question: "Question" }), 502, "provider_invalid_response");
  const limited = await chat({ question: "Question" });
  assert.equal(limited.headers.get("retry-after"), "8");
  assert.equal(limited.headers.get("access-control-allow-origin"), origin);
  const message = await assertError(limited, 429, "provider_rate_limited");
  for (const secret of [providerKey, canary, signingKey]) {
    assert.ok(!message.includes(secret));
    assert.ok(!JSON.stringify(logs).includes(secret));
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => !JSON.stringify(call.body).includes(signingKey)));
});

test("workerd enforces provider deadlines through headers and complete response consumption", { timeout: 12_000 }, async (t) => {
  for (const sendHeaders of [false, true]) {
    await t.test(sendHeaders ? "stalled body" : "stalled headers", async (t) => {
      const upstream = stalledProvider(sendHeaders);
      const { chat } = await startWorker(t, { mock: upstream.mock });
      const response = await chat({ question: "Question" });
      await assertError(response, 504, "provider_timeout");
    });
  }
});

test("workerd cancels provider I/O when the HTTP client disconnects after a complete upload", { timeout: 8_000 }, async (t) => {
  const upstream = stalledProvider(true);
  const { url, chat, calls } = await startWorker(t, {
    mock: (response, call) => call === 1 ? upstream.mock(response) : jsonResponse(response, completion("Recovered.")),
  });
  const pending = rawChat(t, url, (request) => request.end(JSON.stringify({ question: "Question" })));
  const disconnected = assert.rejects(pending.response, { code: "ECONNRESET" });
  await upstream.started;
  // A TCP reset models an abandoned connection. A FIN can be a legitimate HTTP half-close.
  pending.request.socket.resetAndDestroy();
  await disconnected;
  const deadline = new AbortController();
  try {
    await Promise.race([
      upstream.closed,
      delay(1_500, undefined, { signal: deadline.signal }).then(() => assert.fail("Provider connection stayed open after disconnect")),
    ]);
  } finally {
    deadline.abort();
  }
  assert.equal((await chat({ question: "Follow-up" })).status, 200);
  assert.equal(calls.length, 2);
});

test("workerd keeps missing or nonlocal provider configuration and secret details out of responses", async (t) => {
  const signingMissing = await startWorker(t, { bindings: { DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: "" } });
  await assertError(await signingMissing.chat({ question: "Question" }), 503, "conversation_unavailable");
  assert.equal(signingMissing.calls.length, 0);

  const nonlocal = await startWorker(t, { bindings: { OPENROUTER_API_URL: "https://openrouter.ai/api/v1/chat/completions" } });
  await assertError(await nonlocal.chat({ question: "Question" }), 503, "service_not_configured");
  assert.equal(nonlocal.calls.length, 0);
  assert.equal(nonlocal.rejectedOutboundRequests, 0);
});

test("workerd does not follow fixture redirects or forward credentials to a redirect destination", async (t) => {
  const worker = await startWorker(t, {
    mock(response) {
      response.writeHead(307, { Location: "https://provider-redirect.example.invalid/" }).end();
    },
  });
  await assertError(await worker.chat({ question: "Question" }), 502, "provider_error");
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.rejectedOutboundRequests, 0);
});
