import { isZeroCostOpenRouterModel, loadConfig } from "../server/config.mjs";
import {
  MissingProviderConfigurationError,
  OpenRouterError,
  createOpenRouterClient,
} from "../server/openrouter-client.mjs";

const config = loadConfig();
const missingVariables = [];
if (!config.provider.apiKey) missingVariables.push("OPENROUTER_API_KEY");
if (!config.provider.model) missingVariables.push("OPENROUTER_MODEL");

if (missingVariables.length) {
  console.error(JSON.stringify({
    event: "openrouter.diagnostic_configuration_error",
    missingVariables,
  }));
  process.exitCode = 2;
} else {
  const isFreeModel = isZeroCostOpenRouterModel(config.provider.model);
  const paidRequestAuthorized = process.argv.includes("--allow-paid");
  console.log(JSON.stringify({
    event: "openrouter.diagnostic_start",
    model: config.provider.model,
    freeModel: isFreeModel,
    credentialsPresent: true,
    completionLimit: 16,
    automaticFallback: false,
  }));

  if (!isFreeModel && !paidRequestAuthorized) {
    console.error(JSON.stringify({
      event: "openrouter.diagnostic_refused",
      reason: "paid_model_requires_explicit_authorization",
      model: config.provider.model,
      instruction: "Re-run with --allow-paid only after separately authorizing a chargeable request.",
    }));
    process.exitCode = 3;
  } else {
    const client = createOpenRouterClient({
      ...config.provider,
      debug: true,
      maxCompletionTokens: 16,
    });

    try {
      const answer = await client.complete(
        "This is a connectivity diagnostic. Return only OK.",
        [{ role: "user", content: "Reply with OK" }],
      );
      console.log(JSON.stringify({
        event: "openrouter.diagnostic_success",
        model: config.provider.model,
        completionReceived: true,
        completionCharacters: answer.length,
      }));
    } catch (error) {
      if (error instanceof MissingProviderConfigurationError) {
        console.error(JSON.stringify({
          event: "openrouter.diagnostic_configuration_error",
          missingVariables: error.missingVariables,
        }));
        process.exitCode = 2;
      } else if (error instanceof OpenRouterError) {
        console.error(JSON.stringify({
          event: "openrouter.diagnostic_failure",
          code: error.code,
          origin: error.origin,
          correlationId: error.correlationId,
          upstreamResponseReceived: error.upstreamStatus !== null,
          upstreamStatus: error.upstreamStatus,
          transportCategory: error.transport?.category || null,
          transportCode: error.transport?.causeCode || null,
        }));
        process.exitCode = error.origin === "transport" ? 4 : 5;
      } else {
        console.error(JSON.stringify({
          event: "openrouter.diagnostic_failure",
          code: "unexpected_local_error",
          origin: "local",
        }));
        process.exitCode = 6;
      }
    }
  }
}
