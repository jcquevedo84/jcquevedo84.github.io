import type { DigitalTwinAnswer, DigitalTwinContext, DigitalTwinMessage, DigitalTwinRequest } from "./digital-twin-api";

type DisplayMessage = DigitalTwinMessage & { id: number };
type Snapshot = {
  messages: DisplayMessage[];
  loading: boolean;
  error: string | null;
  canRetry: boolean;
};

type RequestAnswer = (request: DigitalTwinRequest, signal: AbortSignal) => Promise<DigitalTwinAnswer>;

function invalidContext(error: unknown) {
  return error instanceof Error && "code" in error
    && (error.code === "conversation_context_expired" || error.code === "invalid_conversation_context");
}

export function createDigitalTwinConversation(requestAnswer: RequestAnswer, welcome: string) {
  const listeners = new Set<() => void>();
  let nextId = 1;
  let conversation: DigitalTwinContext | undefined;
  let retryQuestion: string | undefined;
  let active: AbortController | undefined;

  function initialSnapshot(): Snapshot {
    return { messages: [{ id: 0, role: "assistant", content: welcome }], loading: false, error: null, canRetry: false };
  }

  let snapshot = initialSnapshot();

  function publish(next: Snapshot) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  async function send(question: string, retry: boolean) {
    if (!question || active) return;

    const controller = new AbortController();
    active = controller;
    retryQuestion = question;
    const messages: DisplayMessage[] = retry
      ? snapshot.messages
      : [...snapshot.messages, { id: nextId++, role: "user", content: question }];
    publish({ messages, loading: true, error: null, canRetry: false });

    try {
      const result = await requestAnswer({ question, ...(conversation ? { conversation } : {}) }, controller.signal);
      if (active !== controller) return;
      active = undefined;
      retryQuestion = undefined;
      conversation = result.conversation;
      publish({
        messages: [...messages, { id: nextId++, ...result.message }],
        loading: false,
        error: null,
        canRetry: false,
      });
    } catch (error) {
      if (active !== controller) return;
      active = undefined;
      if (invalidContext(error)) conversation = undefined;
      publish({
        messages,
        loading: false,
        error: error instanceof Error ? error.message : "The Digital Twin is temporarily unavailable.",
        canRetry: true,
      });
    }
  }

  function detachRequest() {
    const previous = active;
    active = undefined;
    previous?.abort();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    submit: (question: string) => send(question.trim(), false),
    retry: () => snapshot.canRetry && retryQuestion ? send(retryQuestion, true) : Promise.resolve(),
    cancel() {
      if (!active) return;
      detachRequest();
      publish({ ...snapshot, loading: false, canRetry: Boolean(retryQuestion) });
    },
    reset() {
      detachRequest();
      conversation = undefined;
      retryQuestion = undefined;
      publish(initialSnapshot());
    },
  };
}
