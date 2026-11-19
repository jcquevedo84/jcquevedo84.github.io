import { createServer } from "node:http";
import { MissingProviderConfigurationError, OpenRouterError } from "./openrouter-client.mjs";
import { isAllowedOrigin } from "./security.mjs";
import { REQUEST_LIMITS, RequestValidationError } from "./validation.mjs";

class PayloadTooLargeError extends Error {}
class BodyReadTimeoutError extends Error {}

const BODY_READ_TIMEOUT_MS = 10_000;
const REJECTION_FLUSH_TIMEOUT_MS = 1_000;

function canStartResponse(response) {
  return !response.headersSent && !response.writableEnded && !response.destroyed
    && response.socket?.writable === true;
}

function closeUnfinished(response) {
  if (!response.writableEnded && !response.destroyed) response.destroy();
}

function sendJson(response, status, payload, origin, additionalHeaders = {}) {
  if (!canStartResponse(response)) {
    closeUnfinished(response);
    return;
  }

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

function sendClosingJson(response, status, payload, origin, additionalHeaders = {}) {
  if (!canStartResponse(response)) {
    closeUnfinished(response);
    return;
  }

  const socket = response.socket;
  const timer = setTimeout(() => socket.destroy(), REJECTION_FLUSH_TIMEOUT_MS);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
  sendJson(response, status, payload, origin, { ...additionalHeaders, Connection: "close" });
}

function requestPath(method, target) {
  if (method === "OPTIONS" && target === "*") return target;

  const invalidTarget = () => new RequestValidationError("The request target is invalid.", "invalid_request_target");
  if (!target || /[^!-~]|[#\\]|%(?![\da-f]{2})/i.test(target)) throw invalidTarget();

  // Treat a leading slash as a path, even when it is followed by another slash.
  const absoluteTarget = target.startsWith("/") ? `http://localhost${target}` : target;
  if (!/^https?:\/\/[^/?]+/i.test(absoluteTarget)) throw invalidTarget();

  let url;
  try {
    url = new URL(absoluteTarget);
  } catch {
    throw invalidTarget();
  }
  if (url.username || url.password) throw invalidTarget();
  return url.pathname;
}

function validateContentLength(request) {
  const length = request.headers["content-length"];
  if (length === undefined) return;
  if (!/^\d+$/.test(length)) {
    throw new RequestValidationError("The Content-Length header is invalid.", "invalid_content_length");
  }
  if (Number(length) > REQUEST_LIMITS.maximumBodyBytes) throw new PayloadTooLargeError();
}

function readBody(request, signal, timeoutMs) {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => finish(new BodyReadTimeoutError()), timeoutMs);

    function finish(error) {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        request.pause();
        reject(error);
      } else {
        resolve(chunks);
      }
    }

    function onData(chunk) {
      size += chunk.length;
      if (size > REQUEST_LIMITS.maximumBodyBytes) {
        finish(new PayloadTooLargeError());
      } else {
        chunks.push(chunk);
      }
    }

    function onEnd() {
      finish();
    }

    function onAbort() {
      finish(signal.reason);
    }

    signal.addEventListener("abort", onAbort, { once: true });
    request.once("end", onEnd);
    request.on("data", onData);
  });
}

async function readJsonBody(request, signal, timeoutMs) {
  const chunks = await readBody(request, signal, timeoutMs);
  const body = Buffer.concat(chunks);

  try {
    return JSON.parse(body.toString("utf8"));
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

  // A local I/O limit takes precedence over a status from an incomplete response.
  const localLimit = error.code === "response_too_large"
    || (error.code === "timeout" && error.origin === "transport_after_headers");
  const status = localLimit ? null : error.status;
  if (error.code === "rate_limit_exceeded" || status === 429) {
    return {
      status: 429,
      payload: { error: { code: "provider_rate_limited", message: "The Digital Twin is busy. Please try again shortly." } },
      headers: error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {},
    };
  }

  if (error.code === "timeout" || status === 408 || status === 504) {
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

  if (["empty_provider_response", "invalid_provider_response", "response_too_large"].includes(error.code)) {
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

export function createDigitalTwinHttpServer({ config, chatService, rateLimiter, bodyTimeoutMs = BODY_READ_TIMEOUT_MS }) {
  async function handleRequest(request, response, expectContinue) {
    let origin = null;
    const controller = new AbortController();
    const { signal } = controller;
    const disconnect = () => controller.abort();
    const onRequestClose = () => {
      if (!request.complete) disconnect();
    };
    const onResponseClose = () => {
      if (!response.writableFinished) disconnect();
    };

    function reply(status, payload, headers) {
      const hasBody = request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"]) > 0;
      const send = expectContinue || (hasBody && !request.complete) ? sendClosingJson : sendJson;
      send(response, status, payload, origin, headers);
    }

    try {
      request.once("close", onRequestClose);
      request.once("error", disconnect);
      response.once("close", onResponseClose);
      response.once("error", disconnect);

      const method = request.method || "GET";
      const requestOrigin = typeof request.headers.origin === "string" ? request.headers.origin.replace(/\/$/, "") : null;
      origin = isAllowedOrigin(requestOrigin, config.allowedOrigins) ? requestOrigin : null;
      const pathname = requestPath(method, request.url);

      if (method === "GET" && pathname === "/health") {
        const configurationIssues = [];
        if (!config.provider.apiKey) configurationIssues.push("OPENROUTER_API_KEY");
        if (!config.provider.model) configurationIssues.push("OPENROUTER_MODEL");
        reply(200, {
          status: configurationIssues.length ? "degraded" : "ok",
          providerConfigured: configurationIssues.length === 0,
          model: config.provider.model || null,
          ...(configurationIssues.length ? { configurationIssues } : {}),
        });
        return;
      }

      if (method === "OPTIONS" && pathname === "/v1/chat") {
        if (!origin) {
          reply(403, { error: { code: "origin_not_allowed", message: "This origin is not allowed." } });
          return;
        }
        if (canStartResponse(response)) {
          response.writeHead(204, {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600",
            Vary: "Origin",
          });
          response.end();
        } else {
          closeUnfinished(response);
        }
        return;
      }

      if (method !== "POST" || pathname !== "/v1/chat") {
        reply(404, { error: { code: "not_found", message: "Endpoint not found." } });
        return;
      }

      if (!origin) {
        reply(403, { error: { code: "origin_not_allowed", message: "This origin is not allowed." } });
        return;
      }

      const rate = rateLimiter.consume(clientAddress(request, config.trustProxy));
      if (!rate.allowed) {
        reply(
          429,
          { error: { code: "rate_limited", message: "Too many requests. Please wait before trying again." } },
          { "Retry-After": String(rate.retryAfterSeconds) },
        );
        return;
      }

      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        reply(415, { error: { code: "unsupported_media_type", message: "Content-Type must be application/json." } });
        return;
      }

      validateContentLength(request);
      if (expectContinue) {
        if (!canStartResponse(response)) {
          closeUnfinished(response);
          return;
        }
        response.writeContinue();
        expectContinue = false;
      }

      const payload = await readJsonBody(request, signal, bodyTimeoutMs);
      signal.throwIfAborted();
      const message = await chatService.answer(payload?.messages, { signal });
      signal.throwIfAborted();
      sendJson(response, 200, { message }, origin);
    } catch (error) {
      if (signal.aborted || !canStartResponse(response)) {
        closeUnfinished(response);
        return;
      }

      if (error instanceof PayloadTooLargeError) {
        sendClosingJson(response, 413, { error: { code: "payload_too_large", message: "The request is too large." } }, origin);
        return;
      }

      if (error instanceof BodyReadTimeoutError) {
        sendClosingJson(response, 408, { error: { code: "request_body_timeout", message: "The request body took too long to arrive." } }, origin);
        return;
      }

      if (error instanceof RequestValidationError) {
        reply(400, { error: { code: error.code, message: error.message } });
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

      reply(500, { error: { code: "internal_error", message: "The Digital Twin encountered an unexpected error." } });
    } finally {
      request.off("close", onRequestClose);
      request.off("error", disconnect);
      response.off("close", onResponseClose);
      response.off("error", disconnect);
    }
  }

  function dispatchRequest(request, response, expectContinue = false) {
    // EventEmitter does not observe a request listener's returned promise.
    void handleRequest(request, response, expectContinue).catch(() => {
      closeUnfinished(response);
    });
  }

  const server = createServer(dispatchRequest);
  server.on("checkContinue", (request, response) => dispatchRequest(request, response, true));
  return server;
}
