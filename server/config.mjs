const DEFAULT_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function isZeroCostOpenRouterModel(model) {
  const normalizedModel = String(model || "").trim().toLowerCase();
  return normalizedModel === "openrouter/free" || normalizedModel.endsWith(":free");
}

export function loadConfig(environment = process.env) {
  const configuredOrigins = environment.DIGITAL_TWIN_ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const apiKey = environment.OPENROUTER_API_KEY?.trim() || "";
  const signingKey = environment.DIGITAL_TWIN_CONVERSATION_SIGNING_KEY?.trim() || "";

  return {
    port: boundedInteger(environment.DIGITAL_TWIN_PORT, 8787, 1024, 65535),
    host: environment.DIGITAL_TWIN_HOST?.trim() || "127.0.0.1",
    allowedOrigins: new Set(configuredOrigins?.length ? configuredOrigins : DEFAULT_ORIGINS),
    trustProxy: environment.DIGITAL_TWIN_TRUST_PROXY === "true",
    conversationSigningKey: signingKey === apiKey ? "" : signingKey,
    rateLimit: {
      requests: boundedInteger(environment.DIGITAL_TWIN_RATE_LIMIT_REQUESTS, 8, 1, 100),
      windowMs: boundedInteger(environment.DIGITAL_TWIN_RATE_LIMIT_WINDOW_MS, 600_000, 10_000, 3_600_000),
    },
    provider: {
      apiKey,
      apiUrl: environment.OPENROUTER_API_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions",
      model: environment.OPENROUTER_MODEL?.trim() || "",
      debug: environment.OPENROUTER_DEBUG === "true",
      maxCompletionTokens: boundedInteger(environment.OPENROUTER_MAX_COMPLETION_TOKENS, 1_500, 64, 2_000),
      timeoutMs: boundedInteger(environment.OPENROUTER_TIMEOUT_MS, 25_000, 3_000, 60_000),
      siteUrl: environment.DIGITAL_TWIN_SITE_URL?.trim() || "http://localhost:3000",
      title: "Juan Carlos Rodriguez Quevedo - Digital Twin",
    },
  };
}
