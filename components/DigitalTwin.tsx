"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  requestDigitalTwinAnswer,
  type DigitalTwinMessage,
  type DigitalTwinRole,
} from "@/lib/digital-twin-api";

type UiMessage = DigitalTwinMessage & {
  id: string;
  welcome?: boolean;
};

const WELCOME_MESSAGE =
  "Hello — I’m JC’s AI Digital Twin. I can answer questions about Juan Carlos’s documented professional background, engineering experience, education, and technical approach.";

const SUGGESTED_QUESTIONS = [
  "Tell me about your backend engineering experience.",
  "What is your experience with Java and Spring Boot?",
  "What is your experience with payment systems?",
  "Can you explain your experience designing distributed systems?",
  "What makes you a strong candidate for a Tech Lead position?",
  "What is your educational background?",
  "What technologies and skills are you currently learning?",
];

function createMessage(role: DigitalTwinRole, content: string, welcome = false): UiMessage {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`,
    role,
    content,
    welcome,
  };
}

function initialMessages(): UiMessage[] {
  return [createMessage("assistant", WELCOME_MESSAGE, true)];
}

export function DigitalTwin() {
  const [open, setOpen] = useState(false);
  const [contactVisible, setContactVisible] = useState(false);
  const [heroActionsVisible, setHeroActionsVisible] = useState(false);
  const [portraitVisible, setPortraitVisible] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const requestControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;

    const launcher = launcherRef.current;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 80);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }

      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      launcher?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, loading, error, open]);

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  useEffect(() => {
    const contact = document.querySelector("#contact");
    if (!contact || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => setContactVisible(entry.isIntersecting),
      { threshold: 0.01 },
    );
    observer.observe(contact);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const heroActions = document.querySelector(".hero-actions");
    if (!heroActions || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => setHeroActionsVisible(entry.isIntersecting),
      { threshold: 0.01 },
    );
    observer.observe(heroActions);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const portrait = document.querySelector(".professional-portrait");
    if (!portrait || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => setPortraitVisible(entry.isIntersecting),
      { threshold: 0.01 },
    );
    observer.observe(portrait);
    return () => observer.disconnect();
  }, []);

  const submitQuestion = async (question: string, appendQuestion = true) => {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion || loading) return;

    setError(null);
    setLastQuestion(normalizedQuestion);
    setDraft("");

    const nextMessages = appendQuestion
      ? [...messages, createMessage("user", normalizedQuestion)]
      : messages;
    if (appendQuestion) setMessages(nextMessages);

    const history = nextMessages
      .filter((message) => !message.welcome)
      .slice(-10)
      .map(({ role, content }) => ({ role, content }));

    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);

    try {
      const answer = await requestDigitalTwinAnswer(history, controller.signal);
      setMessages((current) => [...current, createMessage("assistant", answer)]);
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setError(requestError instanceof Error ? requestError.message : "The Digital Twin is temporarily unavailable.");
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      setLoading(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitQuestion(draft);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitQuestion(draft);
    }
  };

  const startNewConversation = () => {
    requestControllerRef.current?.abort();
    setMessages(initialMessages());
    setDraft("");
    setError(null);
    setLastQuestion(null);
    setLoading(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const launcherObscured = contactVisible && !open;

  return (
    <div className={`digital-twin${open ? " is-open" : ""}${launcherObscured ? " contact-visible" : ""}${heroActionsVisible ? " hero-actions-visible" : ""}${portraitVisible ? " portrait-visible" : ""}`}>
      {open && <button className="twin-backdrop" aria-label="Close Digital Twin" onClick={() => setOpen(false)} />}

      <button
        ref={launcherRef}
        className="twin-launcher"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-hidden={launcherObscured}
        tabIndex={launcherObscured ? -1 : 0}
        onClick={() => setOpen(true)}
      >
        <span className="twin-launcher-mark" aria-hidden="true"><i /> AI</span>
        <span><b>Ask JC&apos;s</b><small>Digital Twin</small></span>
        <i aria-hidden="true">↗</i>
      </button>

      {open && (
        <aside
          ref={panelRef}
          className="twin-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="twin-title"
          aria-describedby="twin-disclosure"
        >
          <header className="twin-header">
            <div className="twin-identity">
              <span aria-hidden="true"><i /> JC</span>
              <div><p id="twin-title">JC&apos;s Digital Twin</p><small>Professional AI assistant</small></div>
            </div>
            <div className="twin-header-actions">
              <button type="button" onClick={startNewConversation}>New conversation</button>
              <button className="twin-close" type="button" aria-label="Close Digital Twin" onClick={() => setOpen(false)}>×</button>
            </div>
          </header>

          <div className="twin-context-bar"><span /> DOCUMENTED PROFESSIONAL KNOWLEDGE · EN / ES</div>

          <div className="twin-conversation" aria-live="polite" aria-busy={loading}>
            {messages.map((message) => (
              <div className={`twin-message twin-message-${message.role}`} key={message.id}>
                <span>{message.role === "assistant" ? "AI" : "YOU"}</span>
                <p>{message.content}</p>
              </div>
            ))}

            {messages.length === 1 && (
              <div className="twin-suggestions" aria-label="Suggested questions">
                <p>Suggested recruiter questions</p>
                {SUGGESTED_QUESTIONS.map((question) => (
                  <button type="button" key={question} disabled={loading} onClick={() => void submitQuestion(question)}>
                    {question}<span aria-hidden="true">→</span>
                  </button>
                ))}
              </div>
            )}

            {loading && (
              <div className="twin-message twin-message-assistant twin-typing" aria-label="Digital Twin is preparing a response">
                <span>AI</span><p><i /><i /><i /></p>
              </div>
            )}

            {error && (
              <div className="twin-error" role="alert">
                <p>{error}</p>
                {lastQuestion && <button type="button" onClick={() => void submitQuestion(lastQuestion, false)}>Retry</button>}
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form className="twin-composer" onSubmit={handleSubmit}>
            <label htmlFor="twin-question" className="sr-only">Ask a professional question</label>
            <textarea
              ref={inputRef}
              id="twin-question"
              value={draft}
              maxLength={2000}
              rows={2}
              disabled={loading}
              placeholder="Ask about experience, architecture, payments, or leadership…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleInputKeyDown}
            />
            <button type="submit" disabled={loading || !draft.trim()} aria-label="Send question">↑</button>
          </form>

          <p className="twin-disclosure" id="twin-disclosure">
            AI-generated answers based on a curated professional profile. This is an AI representation, not Juan Carlos speaking live. Do not share sensitive information.
          </p>
        </aside>
      )}
    </div>
  );
}
