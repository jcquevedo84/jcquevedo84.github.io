import { createChatService } from "./chat-service.mjs";
import { loadConfig } from "./config.mjs";
import { createConversationContext } from "./conversation-context.mjs";
import { createDigitalTwinHttpServer } from "./http-server.mjs";
import { createOpenRouterClient } from "./openrouter-client.mjs";
import { InMemoryRateLimiter } from "./security.mjs";

const config = loadConfig();
const providerClient = createOpenRouterClient(config.provider);
const continuation = await createConversationContext(config.conversationSigningKey);
const chatService = createChatService({ providerClient, continuation });
const rateLimiter = new InMemoryRateLimiter({
  maximumRequests: config.rateLimit.requests,
  windowMs: config.rateLimit.windowMs,
});
const server = createDigitalTwinHttpServer({ config, chatService, rateLimiter });

server.listen(config.port, config.host, () => {
  const providerState = config.provider.apiKey && config.provider.model ? "configured" : "not configured";
  const modelState = config.provider.model || "not configured";
  console.log(`Digital Twin API listening on http://${config.host}:${config.port}`);
  console.log(`Provider: OpenRouter · Model: ${modelState} · Configuration: ${providerState}`);
  console.log(`OpenRouter diagnostics: ${config.provider.debug ? "enabled" : "disabled"}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
