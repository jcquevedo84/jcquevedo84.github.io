export type DigitalTwinRole = "user" | "assistant";

export type DigitalTwinMessage = {
  role: DigitalTwinRole;
  content: string;
};

type ChatResponse = {
  message?: DigitalTwinMessage;
  error?: {
    code?: string;
    message?: string;
  };
};

const SAFE_API_ERRORS: Record<string, string> = {
  service_not_configured: "The Digital Twin service configuration is incomplete.",
  provider_configuration_error: "The Digital Twin AI service configuration needs attention.",
  provider_billing_unavailable: "The Digital Twin AI service usage limit needs attention.",
  provider_model_unavailable: "The configured AI model is currently unavailable.",
  provider_rate_limited: "The Digital Twin is busy. Please try again shortly.",
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
  origin_not_allowed: "The Digital Twin backend rejected this website origin.",
};

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
  messages: DigitalTwinMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const apiBaseUrl = resolveDigitalTwinApiBaseUrl();
  if (!apiBaseUrl) {
    throw new Error("The Digital Twin API has not been configured for this environment.");
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("The Digital Twin backend is unavailable. Confirm the local API is running and retry.");
  }

  let payload: ChatResponse;
  try {
    payload = (await response.json()) as ChatResponse;
  } catch {
    throw new Error("The Digital Twin returned an unreadable response.");
  }

  if (!response.ok || !payload.message?.content) {
    const safeMessage = payload.error?.code ? SAFE_API_ERRORS[payload.error.code] : null;
    throw new Error(safeMessage || payload.error?.message || "The Digital Twin is temporarily unavailable.");
  }

  return payload.message.content;
}
