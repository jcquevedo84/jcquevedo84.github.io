import { OPENROUTER_URL } from "./config.mjs";
import { createProtectedWorker } from "./index.mjs";
import { ACTION, SYNTHETIC_PROMPT, stagingHarness, stagingRoute, stagingUnavailable, syntheticAnswer, validateSyntheticQuestion } from "./staging-shared.mjs";

export { InferenceAdmission } from "./admission.mjs";

const SMOKE_WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

function smokeDeadline(environment, now = Date.now()) {
  const timestamp = environment.STAGING_SMOKE_UNTIL;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp ?? "")) return null;
  const deadline = Date.parse(timestamp);
  return deadline > now && deadline <= now + SMOKE_WINDOW_MS
    && Math.floor(deadline / DAY_MS) === Math.floor(now / DAY_MS)
    && new Date(deadline).toISOString() === timestamp ? deadline : null;
}

function smokeSettings(environment) {
  const deadline = smokeDeadline(environment);
  const key = environment.STAGING_SMOKE_SIGNING_KEY?.trim();
  const apiKey = environment.OPENROUTER_API_KEY?.trim();
  const turnstileKey = environment.TURNSTILE_SECRET_KEY?.trim();
  const fixtureKey = environment.DIGITAL_TWIN_CONVERSATION_SIGNING_KEY?.trim();
  if (!deadline || !apiKey || !turnstileKey || !key
    || [fixtureKey, apiKey, turnstileKey].some((value) => value?.toLowerCase() === key.toLowerCase())
    || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/.test(environment.OPENROUTER_MODEL ?? "")
    || !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(environment.OPENROUTER_ALLOWED_PROVIDERS ?? "")
    || environment.DIGITAL_TWIN_DAILY_LIMIT !== "2" || environment.DIGITAL_TWIN_MINUTE_LIMIT !== "2"
    || environment.DIGITAL_TWIN_MAX_CONCURRENT !== "1" || environment.OPENROUTER_MAX_COMPLETION_TOKENS !== "128") return null;
  return { deadline, key };
}

function syntheticWorker(fetchProvider) {
  return createProtectedWorker({
    fetchProvider,
    buildPrompt: () => SYNTHETIC_PROMPT,
    providerTitle: "Synthetic Digital Twin staging",
    validatePayload: validateSyntheticQuestion,
  });
}

// The fixture always constructs its own response. This transport has no network path.
const fixtureWorker = syntheticWorker(async (_url, { body, signal }) => {
  signal.throwIfAborted();
  const question = JSON.parse(body).messages.at(-1).content;
  const content = syntheticAnswer(question);
  return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
});

const stagingWorker = {
  async fetch(request, environment, context) {
    const route = stagingRoute(request, environment, context);
    if (route instanceof Response) return route;
    const { hostname, origin, testPage } = route;
    const mode = environment.STAGING_MODE;
    const enabled = environment.DIGITAL_TWIN_INFERENCE_ENABLED === "true";
    const smoke = mode === "smoke" && enabled ? smokeSettings(environment) : null;
    const active = enabled && (mode === "fixture" || smoke !== null);
    const bindings = {
      ...environment,
      DIGITAL_TWIN_INFERENCE_ENABLED: active ? "true" : "false",
      DIGITAL_TWIN_ALLOWED_ORIGINS: origin,
      TURNSTILE_EXPECTED_HOSTNAME: hostname,
      TURNSTILE_EXPECTED_ACTION: ACTION,
    };
    if (testPage) {
      return active ? stagingHarness(environment.STAGING_TURNSTILE_SITE_KEY) : stagingUnavailable();
    }
    if (smoke) {
      const worker = syntheticWorker((target, options) => {
        options.signal.throwIfAborted();
        if (target !== OPENROUTER_URL || Date.now() >= smoke.deadline) {
          throw new Error("Staging smoke transport unavailable.");
        }
        return fetch(target, options);
      });
      return worker.fetch(request, { ...bindings, DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: smoke.key }, context);
    }
    return fixtureWorker.fetch(request, {
      ...bindings,
      OPENROUTER_API_KEY: "staging-fixture-placeholder",
      OPENROUTER_MODEL: "synthetic/staging-fixture:free",
      OPENROUTER_ALLOWED_PROVIDERS: "synthetic-fixture",
    }, context);
  },
};

export default stagingWorker;
