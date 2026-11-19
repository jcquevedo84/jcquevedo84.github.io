import { MissingProviderConfigurationError, OpenRouterError } from "./openrouter-client.mjs";

export function providerFailure(error) {
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
