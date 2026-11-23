import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createConversationContext } from "../server/conversation-context.mjs";
import { QUESTIONS } from "./staging-shared.mjs";
import {
  chatHeaders, jsonResponse, providerKey, stagingConfig, stagingFixtureConfig, startWorker, turnstileKey, verification,
} from "./test-fixture.mjs";

const hostname = "digital-twin-staging.synthetic-account.workers.dev";
const origin = `https://${hostname}`;
const audience = "a".repeat(64);
const objectName = "digital-twin-global";

async function startFixture(t, options = {}) {
  const runtime = await startWorker(t, {
    config: stagingFixtureConfig,
    accessAudience: audience,
    mockVerification: (response) => jsonResponse(response, verification({ hostname })),
    ...options,
    bindings: {
      STAGING_MODE: "fixture",
      DIGITAL_TWIN_INFERENCE_ENABLED: "true",
      STAGING_HOST: hostname,
      STAGING_ACCESS_AUD: audience,
      STAGING_TURNSTILE_SITE_KEY: "synthetic-site-key",
      ...options.bindings,
    },
  });
  const route = (path, init = {}) => runtime.workerd.dispatchFetch(new URL(path, origin), {
    cf: { colo: "TEST" }, ...init,
  });
  function chat({ token = randomUUID(), question = QUESTIONS[0], conversation, headers } = {}) {
    return route("/v2/chat", {
      method: "POST",
      headers: { ...chatHeaders(token), Origin: origin, ...headers },
      body: JSON.stringify({ question, conversation }),
    });
  }
  return { ...runtime, route, chat };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error?.code, code);
}

async function until(predicate, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await wait(25);
  }
  assert.fail("The expected local admission state was not reached in time");
}

test("fixture Wrangler config changes only the entry point and keeps ingress and inference off", () => {
  assert.deepEqual(stagingFixtureConfig, { ...stagingConfig, main: "worker/staging-fixture.mjs" });
  assert.deepEqual(stagingFixtureConfig.exports, { InferenceAdmission: { type: "durable-object", storage: "sqlite" } });
  assert.equal(stagingFixtureConfig.workers_dev, false);
  assert.equal(stagingFixtureConfig.preview_urls, false);
  assert.equal(stagingFixtureConfig.vars.STAGING_MODE, "off");
  assert.equal(stagingFixtureConfig.vars.DIGITAL_TWIN_INFERENCE_ENABLED, "false");
});

test("workerd fixture requires native Access on all routes and the canonical staging host", async (t) => {
  const denied = await startFixture(t, { accessAudience: "b".repeat(64) });
  for (const path of ["/health", "/__staging", "/v2/chat"]) {
    await expectError(await denied.route(path, { headers: { "CF-Access-Aud": audience } }), 403, "access_required");
  }
  await expectError(await denied.chat(), 403, "access_required");
  assert.equal(denied.verifications.length, 0);

  const fixture = await startFixture(t);
  await expectError(await fixture.route("https://preview-" + hostname + "/__staging"), 404, "not_found");
  await expectError(await fixture.chat({ headers: { Origin: "https://other.example" } }), 403, "origin_not_allowed");
  const health = await fixture.route("/health");
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal(fixture.verifications.length, 0);
});

test("workerd fixture cannot activate smoke with live-provider configuration and fails closed without protection", async (t) => {
  const versions = [
    ["smoke", { STAGING_MODE: "smoke", OPENROUTER_API_KEY: providerKey, OPENROUTER_MODEL: "test/model:free",
      STAGING_SMOKE_UNTIL: new Date(Date.now() + 60_000).toISOString() }, [], "inference_disabled"],
    ["off", { STAGING_MODE: "off" }, [], "inference_disabled"],
    ["kill switch", { DIGITAL_TWIN_INFERENCE_ENABLED: "false" }, [], "inference_disabled"],
    ["short lease budget", { OPENROUTER_TIMEOUT_MS: "5000" }, [], "protection_unavailable"],
    ...["STAGING_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "DIGITAL_TWIN_CONVERSATION_SIGNING_KEY",
      "ADMISSION", "CHAT_RATE_LIMITER"].map((binding) => [binding, {}, [binding], "protection_unavailable"]),
  ];
  for (const [name, bindings, omit, code] of versions) {
    await t.test(name, async (t) => {
      const fixture = await startFixture(t, { bindings, omit });
      await expectError(await fixture.route("/__staging"), 503, "staging_unavailable");
      await expectError(await fixture.chat(), 503, code);
      assert.equal(fixture.verifications.length, 0);
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.rejectedOutboundRequests, 0);
    });
  }
});

test("workerd fixture holds two six-second leases, rejects replay, and returns signed V2 replies without provider calls", { timeout: 25_000 }, async (t) => {
  const tokens = Array.from({ length: 3 }, () => randomUUID());
  const fixture = await startFixture(t, { bindings: {
    OPENROUTER_API_URL: "https://unapproved.example.invalid",
    OPENROUTER_MODEL: "unapproved/provider:free",
  } });
  const before = Date.now();
  // Consume the fast 429 response while the two admitted requests are still running.
  const results = await Promise.all(tokens.map(async (token) => {
    const response = await fixture.chat({ token });
    return { response, body: await response.json() };
  }));
  assert.deepEqual(results.map(({ response }) => response.status).sort(), [200, 200, 429]);
  assert.ok(Date.now() - before >= 6_000);
  const saturated = results.find(({ response }) => response.status === 429);
  assert.ok(Number(saturated.response.headers.get("retry-after")) > 0);
  assert.equal(saturated.body.error?.code, "capacity");
  const successes = results.flatMap(({ response, body }, index) => response.ok ? [{ body, index }] : []);
  const { body, index } = successes[0];
  assert.match(body.message.content, /JavaScript/);
  await expectError(await fixture.chat({ token: tokens[index] }), 403, "challenge_expired_or_replayed");
  const response = await fixture.chat({ conversation: body.conversation, question: QUESTIONS[1] });
  assert.equal(response.status, 200);
  const followUp = await response.json();
  assert.match(followUp.message.content, /perfil sintético/);
  assert.equal(followUp.conversation.id, body.conversation.id);
  const signer = await createConversationContext(fixture.signingKey);
  assert.equal((await signer.verify(followUp.conversation)).length, 2);
  await expectError(await fixture.chat(), 429, "minute_limit");
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.rejectedOutboundRequests, 0);
  const logs = JSON.stringify(fixture.logs);
  for (const canary of [...tokens, fixture.signingKey, turnstileKey, body.conversation.token, followUp.conversation.token]) {
    assert.ok(!logs.includes(canary));
  }
});

test("workerd cancels the admitted in-memory hold and releases its lease without refunding quota", { timeout: 12_000 }, async (t) => {
  const fixture = await startFixture(t, { inspectAdmission: true, abortRequestAfterMs: 1_500 });
  const storage = await fixture.workerd.unsafeGetDurableObjectStorage(stagingFixtureConfig.name, "InferenceAdmission", { name: objectName });
  const token = randomUUID();
  const pending = fixture.chat({ token });
  const leases = async () => (await storage.exec("SELECT COUNT(*) AS total FROM inference_leases"))[0].total;
  await until(async () => (await storage.exec("SELECT name FROM sqlite_master WHERE name = 'inference_leases'")).length > 0
    && await leases() === 1);
  assert.equal((await pending).status, 499);
  await until(async () => await leases() === 0);
  assert.equal((await storage.exec("SELECT COUNT(*) AS total FROM inference_attempts"))[0].total, 1);
  await expectError(await fixture.chat({ token }), 403, "challenge_expired_or_replayed");
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.rejectedOutboundRequests, 0);
});

test("the protected fixture harness prepares a challenge and replays one exact request without exposing its token", async (t) => {
  const fixture = await startFixture(t);
  const response = await fixture.route("/__staging");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const page = await response.text();
  for (const canary of [fixture.signingKey, turnstileKey, audience, "openrouter.ai"]) assert.ok(!page.includes(canary));
  const elements = Object.fromEntries(["question", "prepare", "send", "replay", "reset", "status", "response"]
    .map((id) => [id, { disabled: true, textContent: "", ...(id === "question" && { value: QUESTIONS[0] }) }]));
  assert.ok(page.includes('id="prepare"') && page.includes('id="replay"'));
  const window = {};
  const submissions = [];
  let callbacks;
  runInNewContext(page.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/)[1], {
    window,
    document: { getElementById: (id) => elements[id] },
    turnstile: { render(_target, options) { callbacks = options; return "synthetic-widget"; }, reset() {}, execute() {} },
    async fetch(url, request) {
      submissions.push({ url, headers: request.headers, body: request.body });
      return submissions.length === 1
        ? Response.json({ message: { content: "Synthetic reply" }, conversation: { id: "synthetic", token: "signed" } })
        : Response.json({ error: { code: "challenge_expired_or_replayed" } }, { status: 403 });
    },
  });
  window.startStaging();
  assert.equal(callbacks["response-field"], false);
  assert.equal(callbacks.action, "digital_twin_chat");
  assert.equal(elements.send.disabled, true);
  elements.prepare.onclick();
  const token = "synthetic-browser-token";
  await callbacks.callback(token);
  assert.equal(submissions.length, 0);
  assert.equal(elements.send.disabled, false);
  await elements.send.onclick();
  assert.equal(submissions[0].url, "/v2/chat");
  assert.equal(submissions[0].headers["X-Digital-Twin-Challenge"], token);
  assert.equal(elements.replay.disabled, false);
  await elements.replay.onclick();
  assert.deepEqual(submissions[0], submissions[1]);
  assert.equal(elements.status.textContent, "403 challenge_expired_or_replayed");
  assert.equal(elements.replay.disabled, true);
  await elements.replay.onclick();
  assert.equal(submissions.length, 2);
  assert.ok(!Object.values(elements).some((element) => element.textContent.includes(token)));
});
