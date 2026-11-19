const encoder = new TextEncoder();
const MAX_DIAGNOSTIC_TEXT = 600;
const MAX_DIAGNOSTIC_JSON = 2_400;
const SENSITIVE_FIELD = /(authorization|api.?key|token|secret|password|credential|hash|user.?id|workspace.?id|prompt|document|knowledge|content)/i;
const SAFE_RESPONSE_HEADERS = [
  "cf-ray",
  "request-id",
  "retry-after",
  "x-request-id",
  "x-openrouter-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

function limitText(value, maximum = MAX_DIAGNOSTIC_TEXT) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…[TRUNCATED]`;
}

export function sanitizeDiagnosticText(value, maximum = MAX_DIAGNOSTIC_TEXT) {
  return limitText(value, maximum)
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/sk-or-v1-[a-z0-9_-]+/gi, "[REDACTED_API_KEY]")
    .replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
}

function sanitizeValue(value, key = "", depth = 0) {
  if (SENSITIVE_FIELD.test(key)) return "[REDACTED]";
  if (depth > 4) return "[TRUNCATED_DEPTH]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeValue(entry, "", depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([entryKey, entryValue]) => [entryKey, sanitizeValue(entryValue, entryKey, depth + 1)]),
    );
  }
  return sanitizeDiagnosticText(String(value));
}

export function redactRequestBody(body) {
  return {
    ...body,
    messages: Array.isArray(body?.messages)
      ? body.messages.map((message) => ({ ...message, content: "[REDACTED]" }))
      : [],
  };
}

export function sanitizeProviderError(payload) {
  const providerError = payload?.error || payload?.choices?.[0]?.error;
  if (!providerError || typeof providerError !== "object") {
    return payload && typeof payload === "object"
      ? { unexpectedResponseKeys: Object.keys(payload).slice(0, 20) }
      : null;
  }

  const sanitized = sanitizeValue(providerError);
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_DIAGNOSTIC_JSON) return sanitized;
  return { truncated: true, preview: sanitizeDiagnosticText(serialized, MAX_DIAGNOSTIC_JSON) };
}

export function safeResponseHeaders(headers) {
  const safe = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = headers?.get?.(name);
    if (value) safe[name] = sanitizeDiagnosticText(value, 200);
  }
  return safe;
}

export function transportFailureDetails(error, timedOut = false) {
  const causeCode = typeof error?.cause?.code === "string"
    ? error.cause.code
    : (typeof error?.code === "string" ? error.code : null);
  const normalizedCode = causeCode?.toUpperCase() || "";
  let category = "network";

  if (/bytestring|header value|invalid header/i.test(String(error?.message || ""))) category = "request_construction";
  else if (timedOut || error?.name === "TimeoutError" || error?.name === "AbortError") category = "timeout";
  else if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(normalizedCode)) category = "dns";
  else if (/TLS|CERT|SSL|UNABLE_TO_VERIFY/.test(normalizedCode)) category = "tls";
  else if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(normalizedCode)) category = "socket";
  else if (["ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(normalizedCode)) category = "connection";

  return {
    category,
    errorName: sanitizeDiagnosticText(error?.name || "Error", 120),
    errorMessage: sanitizeDiagnosticText(error?.message || "Unknown transport failure"),
    causeCode: causeCode ? sanitizeDiagnosticText(causeCode, 120) : null,
    causeName: error?.cause?.name ? sanitizeDiagnosticText(error.cause.name, 120) : null,
    causeMessage: error?.cause?.message ? sanitizeDiagnosticText(error.cause.message) : null,
    timedOut,
  };
}

export function createOpenRouterDiagnostics({
  enabled = false,
  logger = console,
  now = () => Date.now(),
  correlationIdFactory = () => globalThis.crypto.randomUUID(),
} = {}) {
  function emit(record) {
    if (!enabled) return;
    logger.log(JSON.stringify(record));
  }

  return {
    enabled,
    now,
    createCorrelationId: correlationIdFactory,
    request({ correlationId, url, headers, body, bodyText, timeoutMs }) {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      emit({
        event: "openrouter.request",
        timestamp: new Date(now()).toISOString(),
        correlationId,
        method: "POST",
        target: { hostname: url.hostname, path: url.pathname },
        model: body.model,
        contentType: headers["Content-Type"],
        authorizationPresent: Boolean(headers.Authorization),
        requestBodyBytes: encoder.encode(bodyText).byteLength,
        messageCount: messages.length,
        messageRoles: messages.map((message) => message.role),
        messageCharacterLengths: messages.map((message) => String(message.content ?? "").length),
        parameters: {
          temperature: body.temperature,
          maxCompletionTokens: body.max_completion_tokens,
          stream: Boolean(body.stream),
        },
        timeoutMs,
        sanitizedRequest: redactRequestBody(body),
      });
    },
    response({
      correlationId,
      response,
      durationMs,
      payload,
      parsingSucceeded,
      validCompletion,
      bodyBytes,
      parsedErrorCode,
      parsedErrorType,
      completion,
    }) {
      const providerError = payload?.error || payload?.choices?.[0]?.error;
      emit({
        event: "openrouter.response",
        timestamp: new Date(now()).toISOString(),
        correlationId,
        upstreamResponseReceived: true,
        upstreamStatus: response.status,
        upstreamStatusText: sanitizeDiagnosticText(response.statusText, 120),
        durationMs,
        contentType: response.headers.get("content-type"),
        safeHeaders: safeResponseHeaders(response.headers),
        responseBodyBytes: bodyBytes,
        parsingSucceeded,
        validCompletion,
        parsedErrorCode: parsedErrorCode ?? null,
        parsedErrorType: parsedErrorType || null,
        requestedModel: completion?.requestedModel ?? null,
        actualModel: completion?.actualModel ?? null,
        choiceCount: completion?.choiceCount ?? null,
        finishReason: completion?.finishReason ?? null,
        completionTokenLimit: completion?.maxCompletionTokens ?? null,
        promptTokens: completion?.promptTokens ?? null,
        completionTokens: completion?.completionTokens ?? null,
        reasoningTokens: completion?.reasoningTokens ?? null,
        responseTextLength: completion?.responseTextLength ?? null,
        messageContentPresent: completion?.contentPresent ?? false,
        contentStructureSupported: completion?.contentStructureSupported ?? false,
        reasoningPresent: completion?.reasoningPresent ?? false,
        appearsTruncated: completion?.appearsTruncated ?? false,
        sanitizedErrorMessage: providerError?.message
          ? sanitizeDiagnosticText(providerError.message)
          : null,
        sanitizedProviderMetadata: providerError?.metadata
          ? sanitizeValue(providerError.metadata, "metadata")
          : null,
        sanitizedError: response.ok && !providerError ? null : sanitizeProviderError(payload),
      });
    },
    transport({ correlationId, error, durationMs, timedOut, response = null }) {
      const details = transportFailureDetails(error, timedOut);
      emit({
        event: "openrouter.transport_error",
        timestamp: new Date(now()).toISOString(),
        correlationId,
        upstreamResponseReceived: Boolean(response),
        upstreamStatus: response?.status ?? null,
        durationMs,
        ...details,
      });
      return {
        ...details,
        upstreamResponseReceived: Boolean(response),
        upstreamStatus: response?.status ?? null,
      };
    },
  };
}
