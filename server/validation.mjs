export const REQUEST_LIMITS = Object.freeze({
  maximumMessages: 10,
  maximumMessageCharacters: 2_000,
  maximumTotalCharacters: 10_000,
  maximumBodyBytes: 24_000,
});

export class RequestValidationError extends Error {
  constructor(message, code = "invalid_request") {
    super(message);
    this.name = "RequestValidationError";
    this.code = code;
  }
}

export function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RequestValidationError("At least one conversation message is required.");
  }

  if (value.length > REQUEST_LIMITS.maximumMessages) {
    throw new RequestValidationError(`Conversation history is limited to ${REQUEST_LIMITS.maximumMessages} messages.`);
  }

  let totalCharacters = 0;
  const messages = value.map((message) => {
    if (!message || typeof message !== "object") {
      throw new RequestValidationError("Every conversation item must be a message object.");
    }

    if (message.role !== "user" && message.role !== "assistant") {
      throw new RequestValidationError("Only user and assistant messages are accepted.");
    }

    if (typeof message.content !== "string") {
      throw new RequestValidationError("Every message must contain text.");
    }

    const content = message.content.trim();
    if (!content) throw new RequestValidationError("Empty messages are not accepted.");
    if (content.length > REQUEST_LIMITS.maximumMessageCharacters) {
      throw new RequestValidationError(`Messages are limited to ${REQUEST_LIMITS.maximumMessageCharacters} characters.`);
    }

    totalCharacters += content.length;
    return { role: message.role, content };
  });

  if (totalCharacters > REQUEST_LIMITS.maximumTotalCharacters) {
    throw new RequestValidationError("The conversation is too long. Start a new conversation and try again.");
  }

  if (messages.at(-1)?.role !== "user") {
    throw new RequestValidationError("The final conversation message must be from the user.");
  }

  return messages;
}
