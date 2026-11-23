import { Admission } from "./admission.mjs";
import { loadAdmissionLimits, loadProtectionConfig } from "./config.mjs";
import { createProtectedChatWorker } from "./protected-chat.mjs";
import { completeWorkersAi, workersAiFailure, WORKERS_AI_TIMEOUT_MS } from "./workers-ai.mjs";

function loadProductionAdmissionPolicy(environment) {
  return loadAdmissionLimits(environment, WORKERS_AI_TIMEOUT_MS);
}

export class InferenceAdmission extends Admission {
  constructor(ctx, environment) {
    super(ctx, environment, loadProductionAdmissionPolicy(environment));
  }
}

export default createProtectedChatWorker({
  loadConfig(environment) {
    const conversationSigningKey = environment.DIGITAL_TWIN_CONVERSATION_SIGNING_KEY?.trim();
    const protection = loadProtectionConfig(environment, loadProductionAdmissionPolicy(environment), conversationSigningKey);
    return {
      ...protection,
      configured: protection.configured && typeof environment.AI?.run === "function",
      ai: environment.AI,
      providerTimeoutMs: WORKERS_AI_TIMEOUT_MS,
    };
  },
  completeProvider: completeWorkersAi,
  classifyProviderFailure: workersAiFailure,
});
