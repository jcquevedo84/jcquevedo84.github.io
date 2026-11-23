import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createConversationContext } from "../server/conversation-context.mjs";
import { REQUEST_LIMITS } from "../server/validation.mjs";
import { loadWorkerConfig } from "./config.mjs";
import { chatHeaders, completion, jsonResponse, origin, providerKey, providerModel, providerName, runtimeConfig, startWorker, turnstileKey, verification } from "./test-fixture.mjs";

async function assertError(response, status, code) {
  assert.equal(response.status, status);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload), ["error"]);
  assert.deepEqual(Object.keys(payload.error).sort(), ["code", "message"]);
  assert.equal(payload.error.code, code);
  return payload.error.message;
}

test("the legacy OpenRouter configuration can require one explicit free model and provider variant", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.production.jsonc", import.meta.url), "utf8"));
  const env = {
    ...config.vars,
    DIGITAL_TWIN_INFERENCE_ENABLED: "true",
    DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: "a1".repeat(32),
    TURNSTILE_SECRET_KEY: "synthetic-turnstile-key",
    OPENROUTER_API_KEY: "synthetic-provider-key",
  };
  const legacy = loadWorkerConfig(env);
  assert.equal(legacy.configured, true);
  assert.deepEqual(legacy.provider.routingPolicy, {
    only: [env.OPENROUTER_ALLOWED_PROVIDERS],
    zdr: true,
    data_collection: "deny",
    allow_fallbacks: false,
    max_price: { prompt: 0, completion: 0, request: 0 },
  });
  for (const override of [
    { OPENROUTER_MODEL: "openrouter/free" },
    { OPENROUTER_MODEL: "inclusionai/ling-3.2-flash" },
    { OPENROUTER_ALLOWED_PROVIDERS: "antdigital" },
    { OPENROUTER_ALLOWED_PROVIDERS: "antdigital/fp8,other/fp8" },
    { OPENROUTER_API_KEY: "" },
  ]) {
    assert.equal(loadWorkerConfig({ ...env, ...override }).configured, false);
  }
});

function rawChat(t, url, write) {
  const request = httpRequest(new URL("/v2/chat", url), {
    method: "POST",
    headers: chatHeaders(),
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
  assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type, X-Digital-Twin-Challenge");
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
  await assertError(await fetchRoute("/v1/chat", { method: "POST", headers: chatHeaders() }), 404, "not_found");
  await assertError(await fetchRoute("/v2/chat", { headers: chatHeaders() }), 404, "not_found");
  await assertError(await fetchRoute("/v2/chat?q=%ZZ", { method: "POST", headers: chatHeaders() }), 400, "invalid_request_target");
  await assertError(await fetchRoute("/v2/chat", {
    method: "POST", headers: { ...chatHeaders(), "Content-Type": "text/plain" }, body: "{}",
  }), 415, "unsupported_media_type");
  await assertError(await fetchRoute("/v2/chat", { method: "POST", headers: chatHeaders(), body: "{" }), 400, "invalid_json");
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
  assert.deepEqual(calls[1].body.provider, {
    only: [providerName], zdr: true, data_collection: "deny", allow_fallbacks: false,
    max_price: { prompt: 0, completion: 0, request: 0 },
  });
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
  const send = (body) => fetchRoute("/v2/chat", { method: "POST", headers: chatHeaders(), body });
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
  const { url, chat, calls, workerd } = await startWorker(t, {
    bindings: { DIGITAL_TWIN_MAX_CONCURRENT: "1" },
    controlledClock: true,
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
  await assertError(await chat({ question: "Follow-up" }), 429, "capacity");
  const namespace = await workerd.getDurableObjectNamespace("ADMISSION");
  const admission = namespace.get(namespace.idFromName("digital-twin-global"));
  await admission.setClock(Date.now() + 14_000);
  assert.equal((await chat({ question: "Follow-up" })).status, 200);
  assert.equal(calls.length, 2);
  const storage = await workerd.unsafeGetDurableObjectStorage(runtimeConfig.name, "InferenceAdmission", { name: "digital-twin-global" });
  assert.equal((await storage.exec("SELECT COUNT(*) AS total FROM inference_attempts"))[0].total, 2);
});

test("workerd keeps missing or unsafe provider configuration and secret details out of responses", async (t) => {
  const signingMissing = await startWorker(t, { bindings: { DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: "malformed" } });
  await assertError(await signingMissing.chat({ question: "Question" }), 503, "conversation_unavailable");
  assert.equal(signingMissing.calls.length, 0);

  const noRoute = await startWorker(t, { omit: ["OPENROUTER_ALLOWED_PROVIDERS"] });
  await assertError(await noRoute.chat({ question: "Question" }), 503, "protection_unavailable");
  assert.equal(noRoute.calls.length, 0);
  assert.equal(noRoute.verifications.length, 0);
});

test("workerd does not follow OpenRouter redirects or forward credentials to a redirect destination", async (t) => {
  const worker = await startWorker(t, {
    mock(response) {
      response.writeHead(307, { Location: "https://provider-redirect.example.invalid/" }).end();
    },
  });
  await assertError(await worker.chat({ question: "Question" }), 502, "provider_error");
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.rejectedOutboundRequests, 0);
});

test("workerd fails closed on disabled, missing, or invalid protection configuration", async (t) => {
  const cases = [
    { name: "disabled switch", bindings: { DIGITAL_TWIN_INFERENCE_ENABLED: "false" }, code: "inference_disabled" },
    { name: "absent switch", omit: ["DIGITAL_TWIN_INFERENCE_ENABLED"], code: "inference_disabled" },
    { name: "missing edge limiter", omit: ["CHAT_RATE_LIMITER"] },
    { name: "missing admission binding", omit: ["ADMISSION"] },
    { name: "missing Turnstile secret", omit: ["TURNSTILE_SECRET_KEY"] },
    { name: "missing OpenRouter key", omit: ["OPENROUTER_API_KEY"] },
    { name: "reused secret", bindings: { TURNSTILE_SECRET_KEY: providerKey } },
    { name: "paid model", bindings: { OPENROUTER_MODEL: "unreviewed/paid-model" } },
    { name: "invalid daily limit", bindings: { DIGITAL_TWIN_DAILY_LIMIT: "-1" } },
  ];
  for (const { name, code = "protection_unavailable", ...options } of cases) {
    await t.test(name, async (t) => {
      const worker = await startWorker(t, options);
      await assertError(await worker.chat({ question: "Question" }), 503, code);
      assert.equal(worker.calls.length, 0);
      assert.equal(worker.verifications.length, 0);
    });
  }
});

test("workerd issues no provider calls when admission storage cannot load", { timeout: 12_000 }, async (t) => {
  const persistencePath = await mkdtemp(join(tmpdir(), "digital-twin-invalid-schema-"));
  const worker = await startWorker(t, { controlledClock: true, persistencePath });
  const storage = await worker.workerd.unsafeGetDurableObjectStorage(
    runtimeConfig.name, "InferenceAdmission", { name: "digital-twin-global" },
  );
  await storage.exec("UPDATE admission_schema SET version = 99");
  await worker.stop();
  const restarted = await startWorker(t, { persistencePath });
  t.after(() => rm(persistencePath, { recursive: true, force: true }));
  const error = await assertError(await restarted.chat({ question: "Synthetic question" }), 503, "protection_unavailable");
  assert.ok(!error.includes("schema"));
  assert.equal(restarted.calls.length, 0);
});

test("workerd rejects missing edge metadata and ignores forwarding headers for its native rate bucket", async (t) => {
  const worker = await startWorker(t, { rateLimit: 2 });
  const missingIp = chatHeaders();
  delete missingIp["CF-Connecting-IP"];
  missingIp["X-Forwarded-For"] = "192.0.2.20";
  await assertError(await worker.chat({ question: "Question" }, missingIp), 403, "client_identity_unavailable");
  const missingEdge = chatHeaders();
  delete missingEdge["MF-CF-Blob"];
  await assertError(await worker.chat({ question: "Question" }, missingEdge), 403, "client_identity_unavailable");
  for (const address of ["192.0.2.10, 192.0.2.20", "2a06:98c0:3600::103", "999.0.2.10"]) {
    await assertError(await worker.chat({ question: "Question" }, { ...chatHeaders(), "CF-Connecting-IP": address }), 403, "client_identity_unavailable");
  }
  assert.equal(worker.verifications.length, 0);
  assert.equal(worker.calls.length, 0);
  for (let index = 1; index <= 2; index += 1) {
    const response = await worker.chat({ question: "Question" }, { ...chatHeaders(), "X-Forwarded-For": `192.0.2.${index}` });
    assert.equal(response.status, 200);
    await response.json();
  }
  const limited = await worker.chat({ question: "Question" }, { ...chatHeaders(), "X-Real-IP": "192.0.2.30" });
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(limited.headers.get("access-control-expose-headers"), "Retry-After");
  await assertError(limited, 429, "rate_limited");
  assert.equal(worker.verifications.length, 2);
  assert.equal(worker.calls.length, 2);
});

test("workerd verifies bounded Turnstile responses and fails closed on bad tokens, hostname, action, or verifier errors", { timeout: 12_000 }, async (t) => {
  const variants = [
    { body: { success: false, "error-codes": ["invalid-input-response"] }, status: 403, code: "challenge_invalid" },
    { body: { success: false, "error-codes": ["timeout-or-duplicate"] }, status: 403, code: "challenge_expired_or_replayed" },
    { body: verification({ challenge_ts: new Date(Date.now() - 301_000).toISOString() }), status: 403, code: "challenge_expired_or_replayed" },
    { body: verification({ hostname: "wrong.example.invalid" }), status: 403, code: "challenge_invalid" },
    { body: verification({ action: "other" }), status: 403, code: "challenge_invalid" },
    { body: { success: false, "error-codes": ["invalid-input-secret"] }, status: 503, code: "protection_unavailable" },
    { upstreamStatus: 429, body: { error: `synthetic ${turnstileKey}` }, status: 503, code: "protection_unavailable" },
    { body: "{}", status: 503, code: "protection_unavailable" },
    { body: JSON.stringify(verification()).padEnd(16_385), status: 503, code: "protection_unavailable" },
    { stall: true, status: 503, code: "protection_unavailable" },
  ];
  const worker = await startWorker(t, {
    rateLimit: 60,
    mockVerification(response, count) {
      const entry = variants[count - 1];
      if (entry.stall) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"success":');
      } else jsonResponse(response, entry.body, entry.upstreamStatus);
    },
  });
  const missing = chatHeaders();
  delete missing["X-Digital-Twin-Challenge"];
  await assertError(await worker.chat({ question: "Question" }, missing), 400, "challenge_required");
  for (const token of ["two,tokens", "a".repeat(2_049)]) {
    await assertError(await worker.chat({ question: "Question" }, chatHeaders(token)), 400, "challenge_required");
  }
  assert.equal(worker.verifications.length, 0);
  for (const { status, code } of variants) {
    const message = await assertError(await worker.chat({ question: "Synthetic question" }), status, code);
    assert.ok(!message.includes(turnstileKey));
  }
  assert.equal(worker.verifications.length, variants.length);
  assert.equal(worker.verifications[0].body.secret, turnstileKey);
  assert.equal(Object.hasOwn(worker.verifications[0].body, "remoteip"), false);
  assert.equal(worker.calls.length, 0);
  assert.ok(!JSON.stringify(worker.logs).includes(turnstileKey));
});

test("workerd grants at most one call when concurrent Siteverify requests both succeed for one token", async (t) => {
  const waiting = [];
  const worker = await startWorker(t, {
    controlledClock: true,
    mockVerification(response) {
      waiting.push(response);
      if (waiting.length === 2) {
        for (const pending of waiting) jsonResponse(pending, verification());
      }
    },
  });
  const token = "synthetic-replayed-challenge";
  const challenge = chatHeaders(token);
  const responses = await Promise.all([
    worker.chat({ question: "First question" }, challenge),
    worker.chat({ question: "Second question" }, challenge),
  ]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 403]);
  await assertError(responses.find(({ status }) => status === 403), 403, "challenge_expired_or_replayed");
  assert.equal(worker.verifications.length, 2);
  assert.equal(worker.calls.length, 1);
  const storage = await worker.workerd.unsafeGetDurableObjectStorage(
    runtimeConfig.name, "InferenceAdmission", { name: "digital-twin-global" },
  );
  const claims = await storage.exec("SELECT digest FROM challenge_claims");
  assert.deepEqual(Array.from(claims, ({ digest }) => digest), [createHash("sha256").update(token).digest("hex")]);
  assert.ok(!JSON.stringify(worker.logs).includes(token));
});

test("workerd rejects an unacknowledged reservation without dispatching or refunding it", async (t) => {
  const worker = await startWorker(t, {
    controlledClock: true,
    bindings: { DIGITAL_TWIN_DAILY_LIMIT: "1" },
  });
  const namespace = await worker.workerd.getDurableObjectNamespace("ADMISSION");
  const admission = namespace.get(namespace.idFromName("digital-twin-global"));
  await admission.delayNextGrant(2_000);
  await assertError(await worker.chat({ question: "First question" }), 503, "protection_unavailable");
  await assertError(await worker.chat({ question: "Second question" }), 429, "daily_limit");
  assert.equal(worker.calls.length, 0);
});

test("workerd does not refund a failed provider attempt or retry on a missing eligible route", async (t) => {
  const worker = await startWorker(t, {
    bindings: { DIGITAL_TWIN_DAILY_LIMIT: "1" },
    mock: (response) => jsonResponse(response, { error: { message: "No privacy-eligible synthetic endpoint." } }, 404),
  });
  await assertError(await worker.chat({ question: "First question" }), 503, "provider_model_unavailable");
  await assertError(await worker.chat({ question: "Second question" }), 429, "daily_limit");
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.rejectedOutboundRequests, 0);
});

test("workerd keeps provider concurrency at two while both calls are open", { timeout: 7_000 }, async (t) => {
  const open = [];
  const bothStarted = notification();
  const worker = await startWorker(t, {
    mock(response) {
      open.push(response);
      if (open.length === 2) bothStarted.resolve();
    },
  });
  const pending = ["First question", "Second question"].map((question) => worker.chat({ question }));
  try {
    await bothStarted.promise;
    await assertError(await worker.chat({ question: "Third question" }), 429, "capacity");
    assert.equal(worker.calls.length, 2);
  } finally {
    for (const response of open) jsonResponse(response, completion("Finished."));
    await Promise.allSettled(pending);
  }
  assert.ok((await Promise.all(pending)).every(({ status }) => status === 200));
});
