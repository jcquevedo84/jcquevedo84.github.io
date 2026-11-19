import { createChatService, MissingConversationConfigurationError } from "../server/chat-service.mjs";
import { createConversationContext } from "../server/conversation-context.mjs";
import { providerFailure } from "../server/http-errors.mjs";
import { createOpenRouterClient } from "../server/openrouter-client.mjs";
import { isAllowedOrigin } from "../server/security.mjs";
import { ConversationContextError, REQUEST_LIMITS, RequestValidationError } from "../server/validation.mjs";
import { loadWorkerConfig } from "./config.mjs";

const BODY_READ_TIMEOUT_MS = 10_000;

class PayloadTooLargeError extends Error {}
class BodyReadTimeoutError extends Error {}

function json(status, payload, origin, additionalHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...additionalHeaders,
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function errorJson(status, code, message, origin) {
  return json(status, { error: { code, message } }, origin);
}

function validateContentLength(headers) {
  const length = headers.get("Content-Length");
  if (length === null) return;
  if (!/^\d+$/.test(length)) {
    throw new RequestValidationError("The Content-Length header is invalid.", "invalid_content_length");
  }
  if (Number(length) > REQUEST_LIMITS.maximumBodyBytes) throw new PayloadTooLargeError();
}

async function readBody(request) {
  const { signal, body } = request;
  signal.throwIfAborted();
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const chunks = [];
  let bytes = 0;
  let complete = false;
  let cancelled = false;
  let timedOut = false;

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    // Observe cleanup errors without waiting for the upload to finish.
    void reader.cancel().catch(() => {});
  }

  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, BODY_READ_TIMEOUT_MS);
  signal.addEventListener("abort", cancel, { once: true });

  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (timedOut) throw new BodyReadTimeoutError();
      if (done) {
        complete = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > REQUEST_LIMITS.maximumBodyBytes) throw new PayloadTooLargeError();
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    signal.throwIfAborted();
    if (timedOut) throw new BodyReadTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

async function readJsonBody(request) {
  validateContentLength(request.headers);
  const body = await readBody(request);
  try {
    return JSON.parse(body);
  } catch {
    throw new RequestValidationError("The request body must be valid JSON.", "invalid_json");
  }
}

export default {
  async fetch(request, environment) {
    let origin = null;
    const { signal } = request;

    try {
      const config = loadWorkerConfig(environment);
      const requestOrigin = request.headers.get("Origin")?.replace(/\/$/, "");
      origin = isAllowedOrigin(requestOrigin, config.allowedOrigins) ? requestOrigin : null;
      if (/#|%(?![\da-f]{2})/i.test(request.url)) {
        throw new RequestValidationError("The request target is invalid.", "invalid_request_target");
      }
      const { pathname } = new URL(request.url);

      if (request.method === "GET" && pathname === "/health") {
        return json(200, { status: "ok" }, origin);
      }
      if (pathname !== "/v2/chat" || !["POST", "OPTIONS"].includes(request.method)) {
        return errorJson(404, "not_found", "Endpoint not found.", origin);
      }
      if (!origin) return errorJson(403, "origin_not_allowed", "This origin is not allowed.", origin);
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600",
            Vary: "Origin",
          },
        });
      }

      const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") {
        return errorJson(415, "unsupported_media_type", "Content-Type must be application/json.", origin);
      }

      const payload = await readJsonBody(request);
      signal.throwIfAborted();
      const continuation = await createConversationContext(config.conversationSigningKey);
      const providerClient = createOpenRouterClient({
        ...config.provider,
        fetchImpl: (url, options) => fetch(url, { ...options, redirect: "manual" }),
      });
      const chatService = createChatService({ providerClient, continuation });
      const answer = await chatService.answerWithContext(payload, { signal });
      signal.throwIfAborted();
      return json(200, answer, origin);
    } catch (error) {
      // A disconnect leaves no client to receive the response.
      if (signal.aborted) return new Response(null, { status: 499 });
      if (error instanceof PayloadTooLargeError) {
        return errorJson(413, "payload_too_large", "The request is too large.", origin);
      }
      if (error instanceof BodyReadTimeoutError) {
        return errorJson(408, "request_body_timeout", "The request body took too long to arrive.", origin);
      }
      if (error instanceof RequestValidationError) {
        const status = error instanceof ConversationContextError ? error.status : 400;
        return errorJson(status, error.code, error.message, origin);
      }
      if (error instanceof MissingConversationConfigurationError) {
        return errorJson(503, "conversation_unavailable", error.message, origin);
      }
      const failure = providerFailure(error);
      if (failure) return json(failure.status, failure.payload, origin, failure.headers);
      return errorJson(500, "internal_error", "The Digital Twin encountered an unexpected error.", origin);
    }
  },
};
