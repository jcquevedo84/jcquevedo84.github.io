import { createOpenRouterDiagnostics } from "./openrouter-diagnostics.mjs";

const MAX_RESPONSE_BYTES = 256 * 1024;

class ProviderBodyTooLargeError extends Error {}

export class OpenRouterError extends Error {
  constructor(code, {
    upstreamStatus = null,
    retryAfterSeconds = 0,
    origin = "local",
    correlationId = null,
    transport = null,
    completion = null,
  } = {}) {
    super(code);
    this.name = "OpenRouterError";
    this.code = code;
    this.status = upstreamStatus;
    this.upstreamStatus = upstreamStatus;
    this.retryAfterSeconds = retryAfterSeconds;
    this.origin = origin;
    this.correlationId = correlationId;
    this.transport = transport;
    this.completion = completion;
  }
}

export class MissingProviderConfigurationError extends Error {
  constructor(missingVariables) {
    super("provider_not_configured");
    this.name = "MissingProviderConfigurationError";
    this.code = "provider_not_configured";
    this.missingVariables = missingVariables;
  }
}

function errorCodeFromStatus(status) {
  if (status === 400 || status === 413 || status === 422) return "invalid_provider_request";
  if (status === 401) return "authentication";
  if (status === 402) return "payment_required";
  if (status === 403) return "permission_denied";
  if (status === 404) return "model_unavailable";
  if (status === 408 || status === 504 || status === 524) return "timeout";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 529) return "provider_overloaded";
  if (status >= 500) return "provider_unavailable";
  return "provider_error";
}

function extractContent(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = choice?.message;
  if (!message) return { text: "", supported: false };
  if (!("content" in message)) {
    const reasoningOnlyShape = "reasoning" in message || "reasoning_details" in message;
    return { text: "", supported: reasoningOnlyShape };
  }

  const { content } = message;
  if (content === null) return { text: "", supported: true };
  if (typeof content === "string") return { text: content.trim(), supported: true };
  if (!Array.isArray(content)) return { text: "", supported: false };

  const textParts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") return { text: "", supported: false };
    if (!["text", "output_text"].includes(part.type) || typeof part.text !== "string") {
      return { text: "", supported: false };
    }
    textParts.push(part.text);
  }

  return { text: textParts.join("\n").trim(), supported: true };
}

function numericValue(...values) {
  const value = values.find((candidate) => Number.isFinite(candidate));
  return value ?? null;
}

function completionMetadata(payload, requestedModel, maxCompletionTokens, extraction) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = choice?.message;
  const finishReason = choice?.finish_reason ?? choice?.finishReason ?? null;
  const normalizedFinishReason = typeof finishReason === "string" ? finishReason.toLowerCase() : "";
  const usage = payload?.usage && typeof payload.usage === "object" ? payload.usage : {};
  const reasoningTokens = numericValue(
    usage?.completion_tokens_details?.reasoning_tokens,
    usage?.completionTokensDetails?.reasoningTokens,
    usage?.output_tokens_details?.reasoning_tokens,
    usage?.outputTokensDetails?.reasoningTokens,
    usage?.reasoning_tokens,
  );
  const reasoningPresent = Boolean(
    (typeof message?.reasoning === "string" && message.reasoning.trim())
    || (Array.isArray(message?.reasoning_details) && message.reasoning_details.length)
    || (reasoningTokens !== null && reasoningTokens > 0),
  );

  return {
    requestedModel,
    actualModel: typeof payload?.model === "string" ? payload.model : null,
    choiceCount: Array.isArray(payload?.choices) ? payload.choices.length : 0,
    finishReason: typeof finishReason === "string" ? finishReason : null,
    maxCompletionTokens,
    promptTokens: numericValue(usage?.prompt_tokens, usage?.input_tokens),
    completionTokens: numericValue(usage?.completion_tokens, usage?.output_tokens),
    reasoningTokens,
    responseTextLength: extraction.text.length,
    contentPresent: Boolean(extraction.text),
    contentStructureSupported: extraction.supported,
    reasoningPresent,
    appearsTruncated: ["length", "max_tokens", "max_output_tokens"].includes(normalizedFinishReason),
  };
}

function providerError(payload) {
  return payload?.error || payload?.choices?.[0]?.error || null;
}

function providerErrorType(payload) {
  return providerError(payload)?.metadata?.error_type || "";
}

function providerErrorCode(payload) {
  return providerError(payload)?.code ?? null;
}

function errorType(payload, status) {
  const numericProviderStatus = Number(providerErrorCode(payload));
  const effectiveStatus = status >= 400
    ? status
    : (Number.isFinite(numericProviderStatus) ? numericProviderStatus : status);
  const declaredType = String(providerErrorType(payload)).toLowerCase();

  if (/rate.?limit/.test(declaredType)) return "rate_limit_exceeded";
  if (/auth|api.?key/.test(declaredType)) return "authentication";
  if (/payment|credit|billing|budget/.test(declaredType)) return "payment_required";
  if (/permission|forbidden/.test(declaredType)) return "permission_denied";
  if (/model|not.?found/.test(declaredType)) return "model_unavailable";
  if (/timeout/.test(declaredType)) return "timeout";
  if (/overload/.test(declaredType)) return "provider_overloaded";
  return errorCodeFromStatus(effectiveStatus);
}

function retryAfterSeconds(response) {
  const parsed = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readResponseBody(response, signal) {
  if (!response.body) {
    signal.throwIfAborted();
    return { text: "", bytes: 0 };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let complete = false;
  let cancelled = false;

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    // Cancellation settles pending reads. Observe cleanup errors without waiting on the producer.
    void reader.cancel().catch(() => {});
  }

  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        complete = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ProviderBodyTooLargeError();
      if (value.byteLength > 0) chunks.push(value);
    }
    return { text: new TextDecoder().decode(Buffer.concat(chunks, bytes)), bytes };
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export function createOpenRouterClient({
  apiKey,
  apiUrl,
  model,
  debug = false,
  maxCompletionTokens,
  timeoutMs,
  siteUrl,
  title,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = () => Date.now(),
  correlationIdFactory,
}) {
  const diagnostics = createOpenRouterDiagnostics({
    enabled: debug,
    logger,
    now,
    ...(correlationIdFactory ? { correlationIdFactory } : {}),
  });

  return {
    model,
    async complete(systemPrompt, messages, { signal } = {}) {
      signal?.throwIfAborted();
      const missingVariables = [];
      if (!apiKey) missingVariables.push("OPENROUTER_API_KEY");
      if (!model) missingVariables.push("OPENROUTER_MODEL");
      if (missingVariables.length) throw new MissingProviderConfigurationError(missingVariables);

      const correlationId = diagnostics.createCorrelationId();
      const requestUrl = new URL(apiUrl);
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": siteUrl,
        "X-Title": title,
      };
      const body = {
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        temperature: 0.2,
        max_completion_tokens: maxCompletionTokens,
        stream: false,
      };
      const bodyText = JSON.stringify(body);
      const startedAt = now();

      diagnostics.request({ correlationId, url: requestUrl, headers, body, bodyText, timeoutMs });

      const controller = new AbortController();
      const deadline = new Error("The provider request deadline expired.");
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(() => controller.abort(deadline), timeoutMs);

      let response;
      let responseBody;
      try {
        controller.signal.throwIfAborted();
        response = await fetchImpl(apiUrl, {
          method: "POST",
          headers,
          body: bodyText,
          signal: controller.signal,
        });
        responseBody = await readResponseBody(response, controller.signal);
      } catch (error) {
        const timedOut = controller.signal.reason === deadline;
        if (controller.signal.aborted && !timedOut) throw controller.signal.reason;
        if (error instanceof ProviderBodyTooLargeError) {
          throw new OpenRouterError("response_too_large", {
            upstreamStatus: response.status,
            origin: "upstream_body",
            correlationId,
          });
        }

        const transport = diagnostics.transport({
          correlationId,
          error: timedOut ? deadline : error,
          durationMs: Math.max(0, now() - startedAt),
          timedOut,
          response,
        });
        const requestConstructionFailed = !response && transport.category === "request_construction";
        throw new OpenRouterError(
          timedOut ? "timeout" : (requestConstructionFailed ? "request_construction_error" : "network_error"),
          {
            upstreamStatus: response?.status ?? null,
            origin: response ? "transport_after_headers" : (requestConstructionFailed ? "local_request" : "transport"),
            correlationId,
            transport,
          },
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }

      let payload = null;
      let parsingSucceeded = false;
      try {
        payload = JSON.parse(responseBody.text);
        parsingSucceeded = true;
      } catch {
        payload = null;
      }

      const extraction = parsingSucceeded
        ? extractContent(payload)
        : { text: "", supported: false };
      const completion = parsingSucceeded
        ? completionMetadata(payload, model, maxCompletionTokens, extraction)
        : null;
      const hasProviderError = parsingSucceeded && Boolean(providerError(payload));
      const validCompletion = response.ok
        && !hasProviderError
        && Boolean(extraction.text)
        && extraction.supported
        && !completion.appearsTruncated;
      diagnostics.response({
        correlationId,
        response,
        durationMs: Math.max(0, now() - startedAt),
        payload,
        parsingSucceeded,
        validCompletion,
        bodyBytes: responseBody.bytes,
        parsedErrorCode: parsingSucceeded ? providerErrorCode(payload) : null,
        parsedErrorType: parsingSucceeded ? providerErrorType(payload) : null,
        completion,
      });

      if (!parsingSucceeded) {
        throw new OpenRouterError(
          response.ok ? "invalid_provider_response" : errorCodeFromStatus(response.status),
          { upstreamStatus: response.status, origin: "upstream_http", correlationId },
        );
      }

      if (!response.ok || hasProviderError) {
        throw new OpenRouterError(errorType(payload, response.status), {
          upstreamStatus: response.status,
          retryAfterSeconds: retryAfterSeconds(response),
          origin: response.ok ? "upstream_payload" : "upstream_http",
          correlationId,
          completion,
        });
      }

      if (!extraction.supported) {
        throw new OpenRouterError("unsupported_provider_response", {
          upstreamStatus: response.status,
          origin: "upstream_payload",
          correlationId,
          completion,
        });
      }

      if (completion.appearsTruncated) {
        throw new OpenRouterError("truncated_provider_response", {
          upstreamStatus: response.status,
          origin: "upstream_payload",
          correlationId,
          completion,
        });
      }

      if (!extraction.text && completion.reasoningPresent) {
        throw new OpenRouterError("reasoning_only_response", {
          upstreamStatus: response.status,
          origin: "upstream_payload",
          correlationId,
          completion,
        });
      }

      if (!extraction.text) {
        throw new OpenRouterError("empty_provider_response", {
          upstreamStatus: response.status,
          origin: "upstream_payload",
          correlationId,
          completion,
        });
      }
      return extraction.text;
    },
  };
}
