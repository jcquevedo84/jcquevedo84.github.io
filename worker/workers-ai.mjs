const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const MAX_COMPLETION_TOKENS = 640;
const MAX_ANSWER_CHARACTERS = 24_000;
export const WORKERS_AI_TIMEOUT_MS = 40_000;

const failures = {
  provider_rate_limited: [429, "The Digital Twin is busy. Please try again later."],
  provider_timeout: [504, "The Digital Twin took too long to respond. Please retry."],
  provider_model_unavailable: [503, "The configured AI model is currently unavailable."],
  provider_unavailable: [503, "The Digital Twin AI provider is temporarily unavailable."],
  provider_response_truncated: [502, "The AI service stopped before completing its answer. Please retry."],
  provider_invalid_response: [502, "The AI service returned an unusable response. Please retry."],
};

class WorkersAiError extends Error {
  constructor(code) {
    super(failures[code][1]);
    this.code = code;
  }
}

export function workersAiFailure(error) {
  if (!(error instanceof WorkersAiError)) return null;
  return { status: failures[error.code][0], payload: { error: { code: error.code, message: error.message } } };
}

function classifyRunError(error) {
  // The native binding prefixes the upstream error message with its numeric code.
  const code = Number(error?.code ?? /^(\d{4}):/.exec(error?.message ?? "")?.[1]);
  if ([3036, 3040].includes(code) || error?.status === 429) return "provider_rate_limited";
  if ([3007, 3008].includes(code) || [408, 504].includes(error?.status)) return "provider_timeout";
  if ([3042, 5007, 5028, 5035].includes(code)) return "provider_model_unavailable";
  return "provider_unavailable";
}

function visibleReply(result) {
  const choices = result?.choices;
  const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : null;
  const finishReason = choice?.finish_reason ?? result?.finish_reason;
  if (finishReason === "length") throw new WorkersAiError("provider_response_truncated");
  const content = choices === undefined ? result?.response : choice?.message?.content;
  if ((finishReason != null && finishReason !== "stop") || typeof content !== "string"
    || !content.trim() || content.length > MAX_ANSWER_CHARACTERS) {
    throw new WorkersAiError("provider_invalid_response");
  }
  return content.trim();
}

export async function completeWorkersAi({ ai, providerTimeoutMs }, systemPrompt, messages, { signal, start }) {
  start({ upstream: true });
  const deadline = new AbortController();
  const providerSignal = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new WorkersAiError("provider_timeout")), providerTimeoutMs);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(providerSignal.reason);
    providerSignal.addEventListener("abort", onAbort, { once: true });
  });

  let result;
  try {
    result = await Promise.race([aborted, ai.run(MODEL, {
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      chat_template_kwargs: { enable_thinking: false },
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      n: 1,
      store: false,
      stream: false,
    }, { signal: providerSignal, rejectIfBusy: true })]);
    providerSignal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    deadline.signal.throwIfAborted();
    throw new WorkersAiError(classifyRunError(error));
  } finally {
    clearTimeout(timer);
    providerSignal.removeEventListener("abort", onAbort);
  }
  return visibleReply(result);
}
