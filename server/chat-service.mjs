import { selectKnowledge } from "./knowledge-base.mjs";
import { buildSystemPrompt } from "./prompt.mjs";
import { isSensitiveExtractionAttempt, safeExtractionRefusal } from "./security.mjs";
import { validateMessages } from "./validation.mjs";

export function createChatService({ providerClient }) {
  return {
    async answer(rawMessages) {
      const messages = validateMessages(rawMessages);
      const latestQuestion = messages.at(-1).content;

      if (isSensitiveExtractionAttempt(latestQuestion)) {
        return { role: "assistant", content: safeExtractionRefusal(latestQuestion) };
      }

      const knowledge = selectKnowledge(messages);
      const systemPrompt = buildSystemPrompt(knowledge);
      const content = await providerClient.complete(systemPrompt, messages);
      return { role: "assistant", content };
    },
  };
}
