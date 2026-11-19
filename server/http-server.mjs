import { createServer } from "node:http";
import { MissingConversationConfigurationError } from "./chat-service.mjs";
import { providerFailure } from "./http-errors.mjs";
import { isAllowedOrigin } from "./security.mjs";
import { ConversationContextError, REQUEST_LIMITS, RequestValidationError } from "./validation.mjs";

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
      const continuationRoute = pathname === "/v2/chat";
      const chatRoute = continuationRoute || pathname === "/v1/chat";

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

      if (method === "OPTIONS" && chatRoute) {
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

      if (method !== "POST" || !chatRoute) {
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
      const result = continuationRoute
        ? await chatService.answerWithContext(payload, { signal })
        : { message: await chatService.answer(payload?.messages, { signal }) };
      signal.throwIfAborted();
      sendJson(response, 200, result, origin);
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
        reply(error instanceof ConversationContextError ? error.status : 400, { error: { code: error.code, message: error.message } });
        return;
      }

      if (error instanceof MissingConversationConfigurationError) {
        reply(503, { error: { code: "conversation_unavailable", message: error.message } });
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
