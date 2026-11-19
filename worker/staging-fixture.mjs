import { loadAdmissionPolicy } from "./config.mjs";
import { createProtectedChatWorker, hasProtectionBindings } from "./protected-chat.mjs";
import { ACTION, SYNTHETIC_PROMPT, isStagingSiteKey, stagingHarness, stagingRoute, stagingUnavailable, syntheticAnswer, validateSyntheticQuestion } from "./staging-shared.mjs";

export { InferenceAdmission } from "./admission.mjs";

const FIXTURE_DELAY_MS = 6_000;

function loadFixtureConfig(environment) {
  const enabled = environment.STAGING_MODE === "fixture" && environment.DIGITAL_TWIN_INFERENCE_ENABLED === "true";
  const policy = enabled ? loadAdmissionPolicy(environment) : null;
  const { STAGING_HOST: hostname } = environment;
  const secret = environment.TURNSTILE_SECRET_KEY?.trim();
  const conversationSigningKey = environment.DIGITAL_TWIN_CONVERSATION_SIGNING_KEY?.trim();

  return {
    enabled,
    configured: Boolean(policy && policy.providerTimeoutMs > FIXTURE_DELAY_MS && secret
      && isStagingSiteKey(environment.STAGING_TURNSTILE_SITE_KEY)
      && conversationSigningKey && secret !== conversationSigningKey),
    providerTimeoutMs: policy?.providerTimeoutMs,
    allowedOrigins: new Set([`https://${hostname}`]),
    conversationSigningKey,
    turnstile: { hostname, action: ACTION, secret },
  };
}

const chat = createProtectedChatWorker({
  loadConfig: loadFixtureConfig,
  async completeProvider(_config, _prompt, messages, { signal, start }) {
    start();
    await globalThis.scheduler.wait(FIXTURE_DELAY_MS, { signal });
    signal.throwIfAborted();
    return syntheticAnswer(messages.at(-1).content);
  },
  buildPrompt: () => SYNTHETIC_PROMPT,
  validatePayload: validateSyntheticQuestion,
});

const stagingFixture = {
  async fetch(request, environment, context) {
    const route = stagingRoute(request, environment, context);
    if (route instanceof Response) return route;
    if (route.testPage) {
      return loadFixtureConfig(environment).configured && hasProtectionBindings(environment, context)
        ? stagingHarness(environment.STAGING_TURNSTILE_SITE_KEY, { fixtureChecks: true }) : stagingUnavailable();
    }
    return chat.fetch(request, environment, context);
  },
};

export default stagingFixture;
