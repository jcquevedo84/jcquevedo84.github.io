import { toConversationExchange } from "./conversation-context.mjs";
import { selectKnowledge } from "./knowledge-base.mjs";
import { buildSystemPrompt } from "./prompt.mjs";
import { containsSensitiveContext, isSensitiveExtractionAttempt, reviewConversation, safeExtractionRefusal } from "./security.mjs";
import { validateConversationRequest, validateMessages } from "./validation.mjs";

export class MissingConversationConfigurationError extends Error {
  constructor() {
    super("The Digital Twin conversation service is not configured.");
    this.name = "MissingConversationConfigurationError";
  }
}

export function createChatService({ providerClient, continuation = null, selectTopics = selectKnowledge }) {
  async function complete(question, exchanges, signal, remember = false) {
    const { retained, refuse } = reviewConversation(question, exchanges);
    if (refuse) {
      return { message: { role: "assistant", content: safeExtractionRefusal(question) }, exchanges: retained };
    }

    const messages = retained.flatMap(({ question: previousQuestion, answer }) => [
      { role: "user", content: previousQuestion },
      { role: "assistant", content: answer },
    ]);
    messages.push({ role: "user", content: question });

    const systemPrompt = buildSystemPrompt(selectTopics(messages));
    const content = await providerClient.complete(systemPrompt, messages, { signal });
    signal?.throwIfAborted();
    const message = { role: "assistant", content };

    if (!remember || containsSensitiveContext(question, systemPrompt) || containsSensitiveContext(content, systemPrompt)
      || isSensitiveExtractionAttempt(content)) {
      return { message, exchanges: retained };
    }
    const exchange = toConversationExchange(question, content);
    return { message, exchanges: exchange ? [...retained, exchange] : retained };
  }

  return {
    async answer(rawMessages, { signal } = {}) {
      signal?.throwIfAborted();
      const question = validateMessages(rawMessages).at(-1).content;
      const { message } = await complete(question, [], signal);
      return message;
    },

    async answerWithContext(payload, { signal } = {}) {
      signal?.throwIfAborted();
      if (!continuation) throw new MissingConversationConfigurationError();
      const { question, conversation } = validateConversationRequest(payload);
      const id = conversation?.id ?? continuation.newId();
      const exchanges = conversation ? await continuation.verify(conversation) : [];
      signal?.throwIfAborted();
      const result = await complete(question, exchanges, signal, true);
      signal?.throwIfAborted();
      const signed = await continuation.issue(id, result.exchanges);
      signal?.throwIfAborted();
      return { message: result.message, conversation: signed };
    },
  };
}
