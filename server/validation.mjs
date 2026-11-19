export const REQUEST_LIMITS = Object.freeze({
  maximumMessages: 10,
  maximumMessageCharacters: 2_000,
  maximumTotalCharacters: 10_000,
  maximumBodyBytes: 24_000,
});

export const MAX_CONTINUATION_BYTES = 10_000;
export const CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export class RequestValidationError extends Error {
  constructor(message, code = "invalid_request") {
    super(message);
    this.name = "RequestValidationError";
    this.code = code;
  }
}

export class ConversationContextError extends RequestValidationError {
  constructor(expired = false) {
    super(
      expired
        ? "This conversation context has expired. Retry to send your question without the previous context."
        : "This conversation context could not be verified. Retry to send your question without the previous context.",
      expired ? "conversation_context_expired" : "invalid_conversation_context",
    );
    this.name = "ConversationContextError";
    this.status = expired ? 409 : 400;
  }
}

function validateContent(value) {
  if (typeof value !== "string") {
    throw new RequestValidationError("Every message must contain text.");
  }
  const content = value.trim();
  if (!content) throw new RequestValidationError("Empty messages are not accepted.");
  if (content.length > REQUEST_LIMITS.maximumMessageCharacters) {
    throw new RequestValidationError(`Messages are limited to ${REQUEST_LIMITS.maximumMessageCharacters} characters.`);
  }
  return content;
}

function hasOnlyKeys(value, allowed) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

export function validateConversationRequest(value) {
  if (!hasOnlyKeys(value, ["question", "conversation"]) || !Object.hasOwn(value, "question")) {
    throw new RequestValidationError("Send a question and optional signed conversation context.");
  }
  const question = validateContent(value.question);
  if (!Object.hasOwn(value, "conversation")) return { question };

  const { conversation } = value;
  if (!hasOnlyKeys(conversation, ["id", "token"])
    || typeof conversation.id !== "string" || !CONVERSATION_ID_PATTERN.test(conversation.id)
    || typeof conversation.token !== "string" || conversation.token.length > MAX_CONTINUATION_BYTES
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(conversation.token)) {
    throw new ConversationContextError();
  }
  return { question, conversation };
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

    const content = validateContent(message.content);

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
