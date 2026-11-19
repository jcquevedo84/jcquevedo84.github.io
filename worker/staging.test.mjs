import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { createConversationContext } from "../server/conversation-context.mjs";
import {
  chatHeaders, completion, jsonResponse, providerKey, providerModel, providerName,
  stagingConfig, startWorker, turnstileKey, verification,
} from "./test-fixture.mjs";

const hostname = "digital-twin-staging.synthetic-account.workers.dev";
const origin = `https://${hostname}`;
const audience = "a".repeat(64);
const siteKey = "synthetic-site-key";
const english = "What language does the synthetic profile use to build services?";
const spanish = "¿Qué usa el perfil sintético para probar esos servicios?";
const enabled = { STAGING_MODE: "fixture", DIGITAL_TWIN_INFERENCE_ENABLED: "true" };
const deadline = (offset) => new Date(Date.now() + offset).toISOString();
const UTC_DAY_MS = 24 * 60 * 60_000;

async function allowTimeBeforeUtcRollover() {
  const remaining = UTC_DAY_MS - Date.now() % UTC_DAY_MS;
  if (remaining < 10_000) await wait(remaining + 10);
}

async function startStaging(t, options = {}) {
  const runtime = await startWorker(t, {
    config: stagingConfig,
    accessAudience: audience,
    mockVerification: (response) => jsonResponse(response, verification({ hostname })),
    ...options,
    bindings: {
      STAGING_HOST: hostname,
      STAGING_ACCESS_AUD: audience,
      STAGING_TURNSTILE_SITE_KEY: siteKey,
      ...options.bindings,
    },
  });

  function route(path, init) {
    return runtime.workerd.dispatchFetch(new URL(path, origin), { cf: { colo: "TEST" }, ...init });
  }
  function chat(question = english, { token = randomUUID(), conversation, headers, path = "/v2/chat" } = {}) {
    return route(path, {
      method: "POST",
      headers: { ...chatHeaders(token), Origin: origin, ...headers },
      body: JSON.stringify({ question, conversation }),
    });
  }
  return { ...runtime, route, chat };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error?.code, code);
  return body;
}

function smokeBindings(overrides = {}) {
  const now = Date.now();
  const dayEnd = (Math.floor(now / UTC_DAY_MS) + 1) * UTC_DAY_MS;
  return {
    STAGING_MODE: "smoke",
    DIGITAL_TWIN_INFERENCE_ENABLED: "true",
    STAGING_SMOKE_UNTIL: new Date(Math.min(now + 120_000, dayEnd - 1)).toISOString(),
    STAGING_SMOKE_SIGNING_KEY: randomBytes(32).toString("hex"),
    DIGITAL_TWIN_DAILY_LIMIT: "2",
    DIGITAL_TWIN_MINUTE_LIMIT: "2",
    DIGITAL_TWIN_MAX_CONCURRENT: "1",
    OPENROUTER_MAX_COMPLETION_TOKENS: "128",
    ...overrides,
  };
}

test("staging config has no ingress, secrets, or local Access bypass and uses separate resources", async () => {
  assert.equal(stagingConfig.name, "digital-twin-staging");
  assert.equal(stagingConfig.workers_dev, false);
  assert.equal(stagingConfig.preview_urls, false);
  for (const property of ["access", "route", "routes", "assets", "triggers", "services", "env"]) {
    assert.equal(stagingConfig[property], undefined);
  }
  assert.equal(stagingConfig.vars.STAGING_MODE, "off");
  assert.equal(stagingConfig.vars.DIGITAL_TWIN_INFERENCE_ENABLED, "false");
  for (const property of ["STAGING_HOST", "STAGING_ACCESS_AUD", "STAGING_SMOKE_UNTIL", "OPENROUTER_API_KEY",
    "TURNSTILE_SECRET_KEY", "DIGITAL_TWIN_CONVERSATION_SIGNING_KEY", "STAGING_SMOKE_SIGNING_KEY"]) {
    assert.equal(stagingConfig.vars[property], undefined);
  }
  assert.equal(stagingConfig.ratelimits[0].namespace_id, "1002");
  assert.equal(stagingConfig.exports.InferenceAdmission.storage, "sqlite");
});

test("workerd injects the Access audience through native context and all routes require an exact match", async (t) => {
  for (const simulatedAudience of [undefined, "b".repeat(64), audience]) {
    await t.test(simulatedAudience === audience ? "matched" : simulatedAudience ? "mismatched" : "absent", async (t) => {
      const staging = await startStaging(t, { accessAudience: simulatedAudience });
      const headers = {
        "Cf-Access-Jwt-Assertion": audience,
        "Cf-Access-Authenticated-User-Email": "fixture@example.invalid",
        "CF-Access-Aud": audience,
        Cookie: `CF_Authorization=${audience}`,
      };
      const status = simulatedAudience === audience ? 200 : 403;
      const health = await staging.route("/health", { headers });
      assert.equal(health.status, status);
      assert.deepEqual(await health.json(), status === 200 ? { status: "ok" } : {
        error: { code: "access_required", message: "Staging access is required." },
      });
      await expectError(await staging.route("/__staging", { headers }), status === 200 ? 503 : 403,
        status === 200 ? "staging_unavailable" : "access_required");
      await expectError(await staging.chat(english, { headers }), status === 200 ? 503 : 403,
        status === 200 ? "inference_disabled" : "access_required");
      assert.equal(staging.verifications.length, 0);
      assert.equal(staging.calls.length, 0);
    });
  }
});

test("workerd rejects alternate ingress, routes, and HTTP even with the correct simulated audience", async (t) => {
  const staging = await startStaging(t, { bindings: enabled });
  for (const url of [
    "http://" + hostname, origin + ":8787", "https://custom.example.invalid",
    `https://deadbeef-${hostname}`, `https://preview-${hostname}`, `https://deploy.${hostname}`,
    `https://${hostname}.evil.invalid`, `https://${hostname}.`,
  ]) {
    const headers = { Host: hostname, "X-Forwarded-Host": hostname };
    await expectError(await staging.route(`${url}/health`, { headers }), 404, "not_found");
    await expectError(await staging.chat(english, { path: `${url}/v2/chat`, headers }), 404, "not_found");
  }
  for (const path of ["/", "/v1/chat", "/__staging/", "/admission", "/health/", "/static/index.html"]) {
    await expectError(await staging.route(path), 404, "not_found");
  }
  const pagePost = await staging.route("/__staging", { method: "POST" });
  await expectError(pagePost, 404, "not_found");
  assert.equal(staging.calls.length, 0);
  assert.equal(staging.verifications.length, 0);
});

test("workerd denies unconfigured hostname or audience, contradictory off settings, and unknown modes", async (t) => {
  for (const [bindings, status, code] of [
    [{ STAGING_HOST: "" }, 404, "not_found"],
    [{ STAGING_ACCESS_AUD: "" }, 403, "access_required"],
    [{ STAGING_MODE: "off", DIGITAL_TWIN_INFERENCE_ENABLED: "true" }, 503, "inference_disabled"],
    [{ STAGING_MODE: "fixture", DIGITAL_TWIN_INFERENCE_ENABLED: "false" }, 503, "inference_disabled"],
    [{ STAGING_MODE: "unrecognized", DIGITAL_TWIN_INFERENCE_ENABLED: "true" }, 503, "inference_disabled"],
  ]) {
    const staging = await startStaging(t, { bindings });
    await expectError(await staging.chat(), status, code);
    assert.equal(staging.calls.length, 0);
    assert.equal(staging.verifications.length, 0);
    await staging.stop();
  }
});

test("workerd serves the same-origin Turnstile harness and runs keyless bilingual fixtures through V2", async (t) => {
  const staging = await startStaging(t, { bindings: enabled, omit: ["OPENROUTER_API_KEY"] });
  const page = await staging.route("/__staging");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self';.*frame-ancestors 'none'/);
  const markup = await page.text();
  assert.match(markup, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
  assert.match(markup, /action: "digital_twin_chat"/);
  assert.match(markup, /fetch\("\/v2\/chat"/);
  for (const exposed of [providerKey, turnstileKey, staging.signingKey, audience, "openrouter.ai", "Juan Carlos", "localStorage"]) {
    assert.equal(markup.includes(exposed), false);
  }

  const preflight = await staging.route("/v2/chat", { method: "OPTIONS", headers: { Origin: origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.match(preflight.headers.get("access-control-allow-headers"), /X-Digital-Twin-Challenge/);
  await expectError(await staging.chat(english, { headers: { Origin: "https://jcquevedo84.github.io" } }), 403, "origin_not_allowed");

  const first = await staging.chat();
  assert.equal(first.status, 200);
  const answer = await first.json();
  assert.deepEqual(answer.message, { role: "assistant", content: "The synthetic profile uses JavaScript to build services." });
  const second = await staging.chat(spanish, { conversation: answer.conversation });
  assert.equal(second.status, 200);
  const followUp = await second.json();
  assert.match(followUp.message.content, /El perfil sintético/);
  assert.equal(followUp.conversation.id, answer.conversation.id);
  const signer = await createConversationContext(staging.signingKey);
  const history = await signer.verify(followUp.conversation);
  assert.deepEqual(history.map(({ question }) => question), [english, spanish]);
  assert.equal(staging.verifications.length, 2);
  assert.equal(staging.calls.length, 0);
  assert.equal(staging.rejectedOutboundRequests, 0);
});

test("workerd fixture ignores provider overrides and still enforces validation, challenge replay, and quotas", async (t) => {
  const staging = await startStaging(t, { bindings: {
    ...enabled, OPENROUTER_MODEL: providerModel, OPENROUTER_API_KEY: providerKey,
    OPENROUTER_API_URL: "https://unexpected.example.invalid", OPENROUTER_ALLOWED_PROVIDERS: providerName,
    DIGITAL_TWIN_DAILY_LIMIT: "1",
  } });
  await expectError(await staging.chat("An arbitrary question."), 400, "invalid_request");
  await expectError(await staging.chat(english, { token: "" }), 400, "challenge_required");
  const token = randomUUID();
  const first = await staging.chat(english, { token });
  assert.equal(first.status, 200);
  const { message, conversation } = await first.json();
  assert.match(message.content, /synthetic profile/);
  const forged = { ...conversation, id: randomUUID() };
  await expectError(await staging.chat(english, { conversation: forged }), 400, "invalid_conversation_context");
  await expectError(await staging.chat(english, { token }), 403, "challenge_expired_or_replayed");
  await expectError(await staging.chat(), 429, "daily_limit");
  assert.equal(staging.calls.length, 0);
  assert.equal(staging.rejectedOutboundRequests, 0);
});

test("workerd refuses incomplete, expired, or unsafe smoke configuration before Siteverify", async (t) => {
  const fixtureKey = randomBytes(32).toString("hex");
  for (const [name, overrides, omit] of [
    ["kill switch", { DIGITAL_TWIN_INFERENCE_ENABLED: "false" }],
    ["missing deadline", { STAGING_SMOKE_UNTIL: "" }],
    ["expired", { STAGING_SMOKE_UNTIL: deadline(-2000) }],
    ["too far ahead", { STAGING_SMOKE_UNTIL: deadline(660_000) }],
    ["missing key", { STAGING_SMOKE_SIGNING_KEY: "" }],
    ["fixture key reuse", { DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: fixtureKey, STAGING_SMOKE_SIGNING_KEY: fixtureKey.toUpperCase() }],
    ["automatic free routing", { OPENROUTER_MODEL: "openrouter/free" }],
    ["multiple provider routes", { OPENROUTER_ALLOWED_PROVIDERS: "first,second" }],
    ["loose daily limit", { DIGITAL_TWIN_DAILY_LIMIT: "3" }],
    ["loose minute limit", { DIGITAL_TWIN_MINUTE_LIMIT: "3" }],
    ["loose concurrency limit", { DIGITAL_TWIN_MAX_CONCURRENT: "2" }],
    ["loose token limit", { OPENROUTER_MAX_COMPLETION_TOKENS: "1500" }],
    ["missing provider secret", {}, ["OPENROUTER_API_KEY"]],
    ["missing verification secret", {}, ["TURNSTILE_SECRET_KEY"]],
  ]) {
    await t.test(name, async (t) => {
      const staging = await startStaging(t, { bindings: smokeBindings(overrides), omit });
      await expectError(await staging.chat(), 503, "inference_disabled");
      assert.equal(staging.verifications.length, 0);
      assert.equal(staging.calls.length, 0);
      assert.equal(staging.rejectedOutboundRequests, 0);
    });
  }
});

test("workerd smoke uses a separate signing key and admits only two fixed-question calls with strict routing", async (t) => {
  await allowTimeBeforeUtcRollover();
  const bindings = smokeBindings({ OPENROUTER_API_URL: "https://unexpected.example.invalid", OPENROUTER_DEBUG: "true" });
  const staging = await startStaging(t, { bindings, mock: (response) => jsonResponse(response, completion("Synthetic reply.")) });
  const fixtureSigner = await createConversationContext(staging.signingKey);
  const fixtureContext = await fixtureSigner.issue(fixtureSigner.newId(), []);
  await expectError(await staging.chat(english, { conversation: fixtureContext }), 400, "invalid_conversation_context");
  await expectError(await staging.chat("An arbitrary question."), 400, "invalid_request");
  await expectError(await staging.chat(english, { token: "" }), 400, "challenge_required");
  assert.equal(staging.calls.length, 0);

  const token = randomUUID();
  const first = await staging.chat(english, { token });
  assert.equal(first.status, 200);
  const { conversation } = await first.json();
  const smokeSigner = await createConversationContext(bindings.STAGING_SMOKE_SIGNING_KEY);
  assert.equal((await smokeSigner.verify(conversation))[0].question, english);
  await expectError(await staging.chat(english, { token }), 403, "challenge_expired_or_replayed");
  const second = await staging.chat(spanish, { conversation });
  assert.equal(second.status, 200);
  await second.json();
  await expectError(await staging.chat(), 429, "daily_limit");
  assert.equal(staging.calls.length, 2);
  const [{ headers, body }] = staging.calls;
  assert.deepEqual(body.provider, {
    only: [providerName], zdr: true, data_collection: "deny", allow_fallbacks: false,
    max_price: { prompt: 0, completion: 0, request: 0 },
  });
  assert.equal(body.max_completion_tokens, 128);
  assert.equal(body.model, providerModel);
  assert.match(body.messages[0].content, /fictional profile/);
  assert.doesNotMatch(JSON.stringify({ headers, body }), /Juan Carlos|professional_knowledge|jcquevedo84/);
  assert.equal(staging.rejectedOutboundRequests, 0);
  const logs = JSON.stringify(staging.logs);
  for (const secret of [providerKey, turnstileKey, staging.signingKey, bindings.STAGING_SMOKE_SIGNING_KEY, english, conversation.token]) {
    assert.equal(logs.includes(secret), false);
  }
});

test("workerd rechecks smoke expiry after challenge verification and does not dispatch", async (t) => {
  await allowTimeBeforeUtcRollover();
  const end = Date.now() + 2_400;
  const staging = await startStaging(t, {
    bindings: smokeBindings({ STAGING_SMOKE_UNTIL: new Date(end).toISOString() }),
    mockVerification(response) {
      void wait(Math.max(0, end - Date.now() + 50)).then(() => jsonResponse(response, verification({ hostname })));
    },
  });
  await expectError(await staging.chat(), 503, "provider_connection_error");
  assert.equal(staging.verifications.length, 1);
  assert.equal(staging.calls.length, 0);
  assert.equal(staging.rejectedOutboundRequests, 0);
});
