import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { isZeroCostOpenRouterModel, loadConfig } from "./config.mjs";
import { createConversationContext } from "./conversation-context.mjs";

test("conversation signing configuration is independent of the provider key and rejects obvious placeholders", async () => {
  const providerOnly = loadConfig({ OPENROUTER_API_KEY: randomBytes(32).toString("hex") });
  assert.equal(providerOnly.conversationSigningKey, "");
  assert.equal(await createConversationContext(providerOnly.conversationSigningKey), null);
  assert.equal(await createConversationContext(randomBytes(31).toString("hex")), null);
  assert.equal(await createConversationContext("ab".repeat(32)), null);
  assert.equal(await createConversationContext("not a hexadecimal key"), null);

  const signingKey = randomBytes(32).toString("hex");
  assert.equal(loadConfig({
    OPENROUTER_API_KEY: signingKey,
    DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: signingKey,
  }).conversationSigningKey, "");
  const configured = loadConfig({
    OPENROUTER_API_KEY: providerOnly.provider.apiKey,
    DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: signingKey,
  });
  assert.ok(configured.conversationSigningKey === signingKey);
  assert.equal(Object.hasOwn(configured.provider, "conversationSigningKey"), false);
  assert.ok(await createConversationContext(configured.conversationSigningKey));
});

test("configuration uses OPENROUTER_MODEL exactly as provided", () => {
  const config = loadConfig({
    OPENROUTER_API_KEY: "test-key-never-log",
    OPENROUTER_MODEL: "provider/configured-model",
  });

  assert.equal(config.provider.model, "provider/configured-model");
  assert.equal(config.provider.apiKey, "test-key-never-log");
});

test("configuration does not silently substitute a missing OpenRouter model", () => {
  const config = loadConfig({ OPENROUTER_API_KEY: "test-key-never-log" });
  assert.equal(config.provider.model, "");
});

test("configuration preserves the free model identifier and disables diagnostics by default", () => {
  const config = loadConfig({
    OPENROUTER_API_KEY: "test-key-never-log",
    OPENROUTER_MODEL: "openai/gpt-oss-120b:free",
  });
  assert.equal(config.provider.model, "openai/gpt-oss-120b:free");
  assert.equal(config.provider.debug, false);
});

test("configuration enables diagnostics only for the exact true value", () => {
  assert.equal(loadConfig({ OPENROUTER_DEBUG: "true" }).provider.debug, true);
  assert.equal(loadConfig({ OPENROUTER_DEBUG: "TRUE" }).provider.debug, false);
  assert.equal(loadConfig({ OPENROUTER_DEBUG: "1" }).provider.debug, false);
});

test("configuration uses the bounded production completion-token budget", () => {
  assert.equal(loadConfig({}).provider.maxCompletionTokens, 1_500);
  assert.equal(loadConfig({ OPENROUTER_MAX_COMPLETION_TOKENS: "1800" }).provider.maxCompletionTokens, 1_800);
  assert.equal(loadConfig({ OPENROUTER_MAX_COMPLETION_TOKENS: "999999" }).provider.maxCompletionTokens, 2_000);
});

test("OpenRouter attribution header is ASCII-safe for Node fetch", () => {
  const title = loadConfig({}).provider.title;
  assert.equal([...title].every((character) => character.codePointAt(0) <= 127), true);
});

test("diagnostic zero-cost policy recognizes the free router and free model suffix only", () => {
  assert.equal(isZeroCostOpenRouterModel("openrouter/free"), true);
  assert.equal(isZeroCostOpenRouterModel("openai/gpt-oss-120b:free"), true);
  assert.equal(isZeroCostOpenRouterModel(" OPENROUTER/FREE "), true);
  assert.equal(isZeroCostOpenRouterModel("openai/gpt-oss-120b"), false);
  assert.equal(isZeroCostOpenRouterModel("openrouter/auto"), false);
  assert.equal(isZeroCostOpenRouterModel(""), false);
});
