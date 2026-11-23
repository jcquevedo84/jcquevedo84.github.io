import { isZeroCostOpenRouterModel, loadAllowedOrigins, loadConfig } from "../server/config.mjs";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function readLimit(value, fallback, maximum, minimum = 1) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= minimum && number <= maximum ? number : null;
}

export function loadAdmissionLimits(environment, providerTimeoutMs) {
  if (environment.DIGITAL_TWIN_INFERENCE_ENABLED !== "true") return null;
  const day = readLimit(environment.DIGITAL_TWIN_DAILY_LIMIT, 30, 1_000);
  const minute = readLimit(environment.DIGITAL_TWIN_MINUTE_LIMIT, 10, 60);
  const concurrent = readLimit(environment.DIGITAL_TWIN_MAX_CONCURRENT, 2, 16);
  return day && minute && concurrent && providerTimeoutMs ? { day, minute, concurrent, providerTimeoutMs } : null;
}

export function loadAdmissionPolicy(environment) {
  const providerTimeoutMs = readLimit(environment.OPENROUTER_TIMEOUT_MS, 25_000, 60_000, 3_000);
  return loadAdmissionLimits(environment, providerTimeoutMs);
}

export function loadProtectionConfig(environment, policy, conversationSigningKey) {
  const allowedOrigins = loadAllowedOrigins(environment);
  const enabled = environment.DIGITAL_TWIN_INFERENCE_ENABLED === "true";
  const hostname = environment.TURNSTILE_EXPECTED_HOSTNAME;
  const action = environment.TURNSTILE_EXPECTED_ACTION;
  const secret = environment.TURNSTILE_SECRET_KEY?.trim();
  const configured = Boolean(policy && secret && conversationSigningKey && secret !== conversationSigningKey
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(hostname ?? "")
    && /^[\w-]{1,32}$/.test(action ?? "")
    && allowedOrigins.size === 1 && allowedOrigins.has(`https://${hostname}`));
  return { allowedOrigins, enabled, configured, conversationSigningKey, turnstile: { hostname, action, secret } };
}

export function loadWorkerConfig(environment) {
  const { conversationSigningKey, provider } = loadConfig(environment);
  const protection = loadProtectionConfig(environment, loadAdmissionPolicy(environment), conversationSigningKey);
  const { hostname, secret } = protection.turnstile;
  const only = environment.OPENROUTER_ALLOWED_PROVIDERS?.split(",").map((value) => value.trim());
  // A provider slug without a variant can match several endpoints.
  const pinnedRoute = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/.test(provider.model)
    && only?.length === 1 && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(only[0]);
  const configured = Boolean(protection.configured && provider.apiKey && secret !== provider.apiKey
    && isZeroCostOpenRouterModel(provider.model)
    && (environment.OPENROUTER_REQUIRE_PINNED_FREE_ROUTE !== "true" || pinnedRoute)
    && only?.length > 0 && only.length <= 8
    && only.every((value) => /^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(value)));

  return {
    ...protection,
    configured,
    provider: {
      ...provider,
      apiUrl: OPENROUTER_URL,
      siteUrl: `https://${hostname}`,
      debug: false,
      routingPolicy: {
        only,
        zdr: true,
        data_collection: "deny",
        allow_fallbacks: false,
        max_price: { prompt: 0, completion: 0, request: 0 },
      },
    },
  };
}
