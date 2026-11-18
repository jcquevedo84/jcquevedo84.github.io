import { createServer } from "node:http";
import { MissingProviderConfigurationError, OpenRouterError } from "./openrouter-client.mjs";
import { isAllowedOrigin } from "./security.mjs";
import { REQUEST_LIMITS, RequestValidationError } from "./validation.mjs";

class PayloadTooLargeError extends Error {}

function sendJson(response, status, payload, origin, additionalHeaders = {}) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...additionalHeaders,
  };

  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }

  response.writeHead(status, headers);
  response.end(body);
}

async function readJsonBody(request) {
  let size = 0;
  let tooLarge = false;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > REQUEST_LIMITS.maximumBodyBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }

  if (tooLarge) throw new PayloadTooLargeError();

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestValidationError("The request body must be valid JSON.", "invalid_json");
  }
}

function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  }
  return request.socket.remoteAddress || "unknown";
}

function providerFailure(error) {
  if (error instanceof MissingProviderConfigurationError) {
    return {
      status: 503,
      payload: { error: { code: "service_not_configured", message: "The Digital Twin service configuration is incomplete." } },
      headers: {},
    };
  }

  if (!(error instanceof OpenRouterError)) return null;

  if (error.code === "rate_limit_exceeded" || error.status === 429) {
    return {
      status: 429,
      payload: { error: { code: "provider_rate_limited", message: "The Digital Twin is busy. Please try again shortly." } },
      headers: error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {},
    };
  }

  if (error.code === "timeout" || error.status === 408 || error.status === 504) {
    return {
      status: 504,
      payload: { error: { code: "provider_timeout", message: "The Digital Twin took too long to respond. Please retry." } },
      headers: {},
    };
  }

  if (["authentication", "permission_denied"].includes(error.code)) {
    return {
      status: 503,
      payload: { error: { code: "provider_configuration_error", message: "The Digital Twin AI service configuration needs attention." } },
      headers: {},
    };
  }

  if (error.code === "payment_required") {
    return {
      status: 503,
      payload: { error: { code: "provider_billing_unavailable", message: "The Digital Twin AI service usage limit needs attention." } },
      headers: {},
    };
  }

  if (error.code === "model_unavailable") {
    return {
      status: 503,
      payload: { error: { code: "provider_model_unavailable", message: "The configured AI model is currently unavailable." } },
      headers: {},
    };
  }

  if (error.code === "invalid_provider_request") {
    return {
      status: 502,
      payload: { error: { code: "provider_request_rejected", message: "The AI service rejected the request configuration." } },
      headers: {},
    };
  }

  if (error.code === "request_construction_error") {
    return {
      status: 500,
      payload: { error: { code: "provider_request_construction_error", message: "The Digital Twin could not construct the AI service request." } },
      headers: {},
    };
  }

  if (error.code === "network_error") {
    return {
      status: 503,
      payload: { error: { code: "provider_connection_error", message: "The connection to the AI service is temporarily unavailable." } },
      headers: {},
    };
  }

  if (["provider_unavailable", "provider_overloaded"].includes(error.code)) {
    const upstreamBadGateway = error.origin === "upstream_http" && error.upstreamStatus === 502;
    return {
      status: upstreamBadGateway ? 502 : 503,
      payload: {
        error: upstreamBadGateway
          ? { code: "provider_bad_gateway", message: "The AI provider returned an upstream gateway failure." }
          : { code: "provider_unavailable", message: "The Digital Twin AI provider is temporarily unavailable." },
      },
      headers: {},
    };
  }

  if (error.code === "truncated_provider_response") {
    return {
      status: 502,
      payload: { error: { code: "provider_response_truncated", message: "The AI service stopped before completing its answer. Please retry." } },
      headers: {},
    };
  }

  if (error.code === "reasoning_only_response") {
    return {
      status: 502,
      payload: { error: { code: "provider_reasoning_only", message: "The AI service did not return a visible answer. Please retry." } },
      headers: {},
    };
  }

  if (error.code === "unsupported_provider_response") {
    return {
      status: 502,
      payload: { error: { code: "provider_unsupported_response", message: "The AI service returned an unsupported response format. Please retry." } },
      headers: {},
    };
  }

  if (["empty_provider_response", "invalid_provider_response"].includes(error.code)) {
    return {
      status: 502,
      payload: { error: { code: "provider_invalid_response", message: "The AI service returned an unusable response. Please retry." } },
      headers: {},
    };
  }

  return {
    status: 502,
    payload: { error: { code: "provider_error", message: "The Digital Twin could not produce a response. Please retry." } },
    headers: {},
  };
}

export function createDigitalTwinHttpServer({ config, chatService, rateLimiter }) {
  return createServer(async (request, response) => {
    const method = request.method || "GET";
    const url = new URL(request.url || "/", "http://localhost");
    const origin = typeof request.headers.origin === "string" ? request.headers.origin.replace(/\/$/, "") : null;
    const originAllowed = isAllowedOrigin(origin, config.allowedOrigins);

    if (method === "GET" && url.pathname === "/health") {
      const configurationIssues = [];
      if (!config.provider.apiKey) configurationIssues.push("OPENROUTER_API_KEY");
      if (!config.provider.model) configurationIssues.push("OPENROUTER_MODEL");
      sendJson(response, 200, {
        status: configurationIssues.length ? "degraded" : "ok",
        providerConfigured: configurationIssues.length === 0,
        model: config.provider.model || null,
        ...(configurationIssues.length ? { configurationIssues } : {}),
      }, originAllowed ? origin : null);
      return;
    }

    if (method === "OPTIONS" && url.pathname === "/v1/chat") {
      if (!originAllowed) {
        sendJson(response, 403, { error: { code: "origin_not_allowed", message: "This origin is not allowed." } }, null);
        return;
      }
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
      response.end();
      return;
    }

    if (method !== "POST" || url.pathname !== "/v1/chat") {
      sendJson(response, 404, { error: { code: "not_found", message: "Endpoint not found." } }, originAllowed ? origin : null);
      return;
    }

    if (!originAllowed) {
      sendJson(response, 403, { error: { code: "origin_not_allowed", message: "This origin is not allowed." } }, null);
      return;
    }

    const rate = rateLimiter.consume(clientAddress(request, config.trustProxy));
    if (!rate.allowed) {
      sendJson(
        response,
        429,
        { error: { code: "rate_limited", message: "Too many requests. Please wait before trying again." } },
        origin,
        { "Retry-After": String(rate.retryAfterSeconds) },
      );
      return;
    }

    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      sendJson(response, 415, { error: { code: "unsupported_media_type", message: "Content-Type must be application/json." } }, origin);
      return;
    }

    try {
      const payload = await readJsonBody(request);
      const message = await chatService.answer(payload?.messages);
      sendJson(response, 200, { message }, origin);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJson(response, 413, { error: { code: "payload_too_large", message: "The request is too large." } }, origin);
        return;
      }

      if (error instanceof RequestValidationError) {
        sendJson(response, 400, { error: { code: error.code, message: error.message } }, origin);
        return;
      }

      const failure = providerFailure(error);
      if (failure) {
        console.warn(JSON.stringify({
          event: "digital_twin.provider_failure",
          correlationId: error.correlationId || null,
          code: error.code,
          origin: error.origin || "configuration",
          upstreamStatus: error.upstreamStatus ?? null,
          backendStatus: failure.status,
          transportCategory: error.transport?.category || null,
          transportCode: error.transport?.causeCode || null,
        }));
        sendJson(response, failure.status, failure.payload, origin, failure.headers);
        return;
      }

      sendJson(response, 500, { error: { code: "internal_error", message: "The Digital Twin encountered an unexpected error." } }, origin);
    }
  });
}
