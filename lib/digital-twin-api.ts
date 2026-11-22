export type DigitalTwinRole = "user" | "assistant";

export type DigitalTwinMessage = {
  role: DigitalTwinRole;
  content: string;
};

export type DigitalTwinContext = { id: string; token: string };

export type DigitalTwinRequest = {
  question: string;
  conversation?: DigitalTwinContext;
};

export type DigitalTwinAnswer = {
  message: { role: "assistant"; content: string };
  conversation: DigitalTwinContext;
};

export const MAX_QUESTION_UNITS = 2_000;
const MAX_REQUEST_BYTES = 24_000;
const MAX_CONTEXT_BYTES = 10_000;

const SAFE_API_ERRORS: Record<string, string> = {
  service_not_configured: "The Digital Twin service configuration is incomplete.",
  provider_configuration_error: "The Digital Twin AI service configuration needs attention.",
  provider_billing_unavailable: "The Digital Twin AI service usage limit needs attention.",
  provider_model_unavailable: "The free AI service is temporarily unavailable. Please try again later.",
  provider_rate_limited: "The free AI service has reached a temporary limit. Please try again later.",
  provider_timeout: "The Digital Twin took too long to respond. Please retry.",
  provider_connection_error: "The connection to the AI service is temporarily unavailable.",
  provider_unavailable: "The Digital Twin AI provider is temporarily unavailable.",
  provider_bad_gateway: "The AI provider returned an upstream gateway failure.",
  provider_request_rejected: "The AI service rejected the request configuration.",
  provider_request_construction_error: "The Digital Twin could not construct the AI service request.",
  provider_response_truncated: "The AI service stopped before completing its answer. Please retry.",
  provider_reasoning_only: "The AI service did not return a visible answer. Please retry.",
  provider_unsupported_response: "The AI service returned an unsupported response format. Please retry.",
  provider_invalid_response: "The AI service returned an unusable response. Please retry.",
  rate_limited: "Too many requests. Please wait before trying again.",
  claim_limit: "Verification is busy. Please wait before trying again.",
  daily_limit: "The Digital Twin has reached its daily limit. Please try again tomorrow.",
  minute_limit: "The Digital Twin is busy. Please wait a minute before trying again.",
  capacity: "The Digital Twin is answering other questions. Please try again shortly.",
  inference_disabled: "The Digital Twin is temporarily unavailable. You can still reach JC through the contact section.",
  protection_unavailable: "The Digital Twin is temporarily unavailable. Please try again later.",
  challenge_required: "Complete a fresh security check before sending your question.",
  challenge_invalid: "The security check could not be verified. Please retry.",
  challenge_expired_or_replayed: "The security check expired or was already used. Please retry for a fresh check.",
  origin_not_allowed: "The Digital Twin backend rejected this website origin.",
  conversation_unavailable: "The Digital Twin conversation service is not configured.",
  conversation_context_expired: "The conversation context expired. Retry to send your question without the earlier context.",
  invalid_conversation_context: "The conversation context could not be verified. Retry to send your question without the earlier context.",
  invalid_request: "The Digital Twin could not accept this question.",
  payload_too_large: "The Digital Twin request is too large.",
  request_body_timeout: "The request took too long to reach the Digital Twin. Please retry.",
};

export class DigitalTwinApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "DigitalTwinApiError";
    this.code = code;
  }
}

export function resolveDigitalTwinApiBaseUrl(): string | null {
  const configuredUrl = process.env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");

  if (typeof window === "undefined") return null;

  const { hostname, protocol } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${protocol}//${hostname}:8787`;
  }

  return null;
}

export async function requestDigitalTwinAnswer(
  request: DigitalTwinRequest,
  signal?: AbortSignal,
  getChallenge?: () => Promise<string>,
): Promise<DigitalTwinAnswer> {
  signal?.throwIfAborted();
  const apiBaseUrl = resolveDigitalTwinApiBaseUrl();
  if (!apiBaseUrl) {
    throw new Error("The Digital Twin API has not been configured for this environment.");
  }

  const question = request.question.trim();
  if (!question || question.length > MAX_QUESTION_UNITS) {
    throw new DigitalTwinApiError(SAFE_API_ERRORS.invalid_request, "invalid_request");
  }
  const { conversation } = request;
  if (conversation !== undefined && !isContext(conversation)) {
    throw new DigitalTwinApiError(SAFE_API_ERRORS.invalid_conversation_context, "invalid_conversation_context");
  }
  const body = JSON.stringify({ question, conversation: conversation && { id: conversation.id, token: conversation.token } });
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new DigitalTwinApiError(SAFE_API_ERRORS.payload_too_large, "payload_too_large");
  }

  const challenge = await getChallenge?.();
  signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/v2/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(challenge && { "X-Digital-Twin-Challenge": challenge }),
      },
      body,
      signal,
      credentials: "omit",
      redirect: "error",
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("The Digital Twin is temporarily unavailable. Please try again later.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    signal?.throwIfAborted();
    throw new Error("The Digital Twin returned an unreadable response.");
  }
  signal?.throwIfAborted();

  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const code = typeof error?.code === "string" && Object.hasOwn(SAFE_API_ERRORS, error.code) ? error.code : undefined;
    throw new DigitalTwinApiError(code ? SAFE_API_ERRORS[code] : "The Digital Twin is temporarily unavailable.", code);
  }
  if (!isRecord(payload) || !isRecord(payload.message) || payload.message.role !== "assistant"
    || typeof payload.message.content !== "string" || !payload.message.content.trim()
    || !isContext(payload.conversation) || (conversation && payload.conversation.id !== conversation.id)) {
    throw new DigitalTwinApiError("The Digital Twin returned an invalid conversation response.");
  }
  return {
    message: { role: "assistant", content: payload.message.content },
    conversation: { id: payload.conversation.id, token: payload.conversation.token },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContext(value: unknown): value is DigitalTwinContext {
  return isRecord(value) && typeof value.id === "string" && typeof value.token === "string"
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)
    && value.token.length <= MAX_CONTEXT_BYTES && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value.token);
}
