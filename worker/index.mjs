import { providerFailure } from "../server/http-errors.mjs";
import { createOpenRouterClient } from "../server/openrouter-client.mjs";
import { loadWorkerConfig } from "./config.mjs";
import { createProtectedChatWorker } from "./protected-chat.mjs";

export { InferenceAdmission } from "./admission.mjs";

export function createProtectedWorker({ fetchProvider = fetch, buildPrompt, providerTitle, validatePayload } = {}) {
  return createProtectedChatWorker({
    loadConfig(environment) {
      const config = loadWorkerConfig(environment);
      return { ...config, providerTimeoutMs: config.provider.timeoutMs };
    },
    completeProvider({ provider }, systemPrompt, messages, { signal, start }) {
      return createOpenRouterClient({
        ...provider,
        ...(providerTitle && { title: providerTitle }),
        fetchImpl(url, options) {
          start({ signal: options.signal, upstream: true });
          return fetchProvider(url, { ...options, redirect: "manual" });
        },
      }).complete(systemPrompt, messages, { signal });
    },
    classifyProviderFailure: providerFailure,
    buildPrompt,
    validatePayload,
  });
}

export default createProtectedWorker();
