import { loadConfig } from "../server/config.mjs";

export function loadWorkerConfig(environment) {
  const config = loadConfig(environment);
  let providerUrl;
  try {
    providerUrl = new URL(config.provider.apiUrl);
  } catch {
    // An invalid fixture URL leaves inference unavailable.
  }

  // Phase 1 runs against a controlled HTTP fixture on the local machine.
  const mockProviderAllowed = providerUrl?.protocol === "http:" && providerUrl.hostname === "127.0.0.1"
    && Number(providerUrl.port) >= 1024 && !providerUrl.username && !providerUrl.password;

  return {
    allowedOrigins: config.allowedOrigins,
    conversationSigningKey: config.conversationSigningKey,
    provider: {
      ...config.provider,
      apiKey: mockProviderAllowed ? config.provider.apiKey : "",
      debug: false,
    },
  };
}
