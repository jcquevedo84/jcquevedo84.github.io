import { createChatService, MissingConversationConfigurationError } from "../server/chat-service.mjs";
import { createConversationContext } from "../server/conversation-context.mjs";
import { isAllowedOrigin } from "../server/security.mjs";
import { CONVERSATION_ID_PATTERN, ConversationContextError, REQUEST_LIMITS, RequestValidationError, validateConversationRequest } from "../server/validation.mjs";
import { ADMISSION_OBJECT_NAME } from "./admission.mjs";
import { isChallengeToken, verifyTurnstile } from "./turnstile.mjs";

const BODY_READ_TIMEOUT_MS = 10_000;
const BINDING_TIMEOUT_MS = 1_500;
const encoder = new TextEncoder();

class PayloadTooLargeError extends Error {}
class BodyReadTimeoutError extends Error {}

class ProtectionError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = retryAfter ? { "Retry-After": String(retryAfter) } : {};
  }
}

function protectionUnavailable() {
  return new ProtectionError(503, "protection_unavailable", "The Digital Twin is temporarily unavailable.");
}

function challengeRejected(outcome) {
  return ["expired", "replay"].includes(outcome)
    ? new ProtectionError(403, "challenge_expired_or_replayed", "Please complete a fresh challenge.")
    : new ProtectionError(403, "challenge_invalid", "The challenge could not be verified.");
}

function rejectAdmission(result) {
  const { outcome, retryAfter } = result ?? {};
  if (outcome === "replay" || outcome === "expired") throw challengeRejected(outcome);
  if (["claim_limit", "daily_limit", "minute_limit", "capacity"].includes(outcome)
    && Number.isSafeInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 86_400) {
    throw new ProtectionError(429, outcome, "The Digital Twin is busy. Please try again later.", retryAfter);
  }
  throw protectionUnavailable();
}

function trustedClientAddress(request) {
  if (!request.cf?.colo || request.headers.has("CF-Worker")) return null;
  const address = request.headers.get("CF-Connecting-IP");
  if (!address) return null;
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address)) {
    return address.split(".").every((piece) => Number(piece) <= 255) ? address : null;
  }
  if (!address.includes(":") || !/^[\da-f:.]+$/i.test(address)) return null;
  const hostname = URL.parse(`http://[${address}]`)?.hostname;
  if (!hostname || hostname === "[2a06:98c0:3600::103]") return null;
  return hostname;
}

async function callBinding(operation, signal) {
  signal?.throwIfAborted();
  let timer;
  let abort;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(protectionUnavailable()), BINDING_TIMEOUT_MS);
    abort = () => reject(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([deadline, Promise.resolve().then(operation)]);
  } catch {
    signal?.throwIfAborted();
    throw protectionUnavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function recordOutcome(outcome, status, startedAt) {
  const durationBucketMs = Math.max(0, Math.min(120_000, Math.ceil((Date.now() - startedAt) / 100) * 100));
  console.info(JSON.stringify({ event: "digital_twin.request", outcome, status, durationBucketMs }));
}

function protectedProvider(config, admission, digest, context, completeProvider) {
  return {
    async complete(systemPrompt, messages, { signal }) {
      const grant = await callBinding(() => admission.admit(digest), signal);
      if (grant?.outcome !== "admitted") rejectAdmission(grant);
      const { leaseId, startBy, expiresAt } = grant;
      if (typeof leaseId !== "string" || !CONVERSATION_ID_PATTERN.test(leaseId)
        || !Number.isSafeInteger(startBy) || !Number.isSafeInteger(expiresAt)) {
        throw protectionUnavailable();
      }

      let dispatched = false;
      let completed = false;
      let staleGrant = false;
      function start({ signal: dispatchSignal = signal, upstream = false } = {}) {
        dispatchSignal.throwIfAborted();
        const now = Date.now();
        if (now >= startBy || now + config.providerTimeoutMs >= expiresAt) {
          staleGrant = true;
          throw protectionUnavailable();
        }
        dispatched = upstream;
      }

      try {
        const response = await completeProvider(config, systemPrompt, messages, { signal, start });
        completed = true;
        return response;
      } catch (error) {
        signal?.throwIfAborted();
        if (staleGrant) throw protectionUnavailable();
        throw error;
      } finally {
        // A failed call may still be running upstream. Keep its lease until expiry.
        if (completed || !dispatched) {
          context.waitUntil(callBinding(() => admission.release(leaseId)).catch(() => {
            console.info(JSON.stringify({ event: "digital_twin.lease_release_failed" }));
          }));
        }
      }
    },
  };
}

function json(status, payload, origin, additionalHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...additionalHeaders,
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "Retry-After");
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

export function hasProtectionBindings(environment, context) {
  return typeof environment.CHAT_RATE_LIMITER?.limit === "function"
    && typeof environment.ADMISSION?.getByName === "function" && typeof context?.waitUntil === "function";
}

export function createProtectedChatWorker({ loadConfig, completeProvider, classifyProviderFailure, buildPrompt, validatePayload }) {
  async function handleRequest(request, environment, context) {
    let origin = null;
    const { signal } = request;
    const startedAt = Date.now();

    try {
      const config = loadConfig(environment);
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
            "Access-Control-Allow-Headers": "Content-Type, X-Digital-Twin-Challenge",
            "Access-Control-Max-Age": "600",
            Vary: "Origin",
          },
        });
      }

      if (!config.enabled) throw new ProtectionError(503, "inference_disabled", "The Digital Twin is currently unavailable.");
      if (!config.configured || !hasProtectionBindings(environment, context)) {
        throw protectionUnavailable();
      }
      const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") {
        return errorJson(415, "unsupported_media_type", "Content-Type must be application/json.", origin);
      }

      validateContentLength(request.headers);
      const address = trustedClientAddress(request);
      if (!address) throw new ProtectionError(403, "client_identity_unavailable", "The request could not be verified.");
      const rate = await callBinding(() => environment.CHAT_RATE_LIMITER.limit({ key: address }), signal);
      if (rate?.success === false) {
        throw new ProtectionError(429, "rate_limited", "Too many requests. Please wait before trying again.", 60);
      }
      if (rate?.success !== true) throw protectionUnavailable();

      const token = request.headers.get("X-Digital-Twin-Challenge");
      if (!isChallengeToken(token)) {
        throw new ProtectionError(400, "challenge_required", "Complete a fresh challenge before sending a question.");
      }
      const payload = validateConversationRequest(await readJsonBody(request));
      validatePayload?.(payload);
      const continuation = await createConversationContext(config.conversationSigningKey);
      if (!continuation) throw new MissingConversationConfigurationError();

      const verification = await verifyTurnstile(token, config.turnstile, signal);
      if (verification.outcome === "unavailable") throw protectionUnavailable();
      if (verification.outcome !== "verified") throw challengeRejected(verification.outcome);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))).toHex();
      const admission = environment.ADMISSION.getByName(ADMISSION_OBJECT_NAME);
      const claim = await callBinding(() => admission.claim(digest, verification.issuedAt), signal);
      if (claim?.outcome !== "claimed") rejectAdmission(claim);

      const providerClient = protectedProvider(config, admission, digest, context, completeProvider);
      const chatService = createChatService({ providerClient, continuation, buildPrompt });
      const answer = await chatService.answerWithContext(payload, { signal });
      signal.throwIfAborted();
      recordOutcome("answered", 200, startedAt);
      return json(200, answer, origin);
    } catch (error) {
      // A disconnect leaves no client to receive the response.
      if (signal.aborted) return new Response(null, { status: 499 });
      if (error instanceof ProtectionError) {
        recordOutcome(error.code, error.status, startedAt);
        return json(error.status, { error: { code: error.code, message: error.message } }, origin, error.headers);
      }
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
      const failure = classifyProviderFailure?.(error);
      if (failure) {
        recordOutcome(failure.payload.error.code, failure.status, startedAt);
        return json(failure.status, failure.payload, origin, failure.headers);
      }
      return errorJson(500, "internal_error", "The Digital Twin encountered an unexpected error.", origin);
    }
  }
  return { fetch: handleRequest };
}
