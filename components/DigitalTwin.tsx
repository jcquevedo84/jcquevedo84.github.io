"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MAX_QUESTION_UNITS, requestDigitalTwinAnswer, resolveDigitalTwinApiBaseUrl } from "@/lib/digital-twin-api";
import { createDigitalTwinConversation } from "@/lib/digital-twin-conversation";
import { getDigitalTwinChallenge } from "@/lib/digital-twin-turnstile";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_DIGITAL_TWIN_TURNSTILE_SITE_KEY?.trim();

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

export function DigitalTwin() {
  const [open, setOpen] = useState(false);
  const [contactVisible, setContactVisible] = useState(false);
  const [heroActionsVisible, setHeroActionsVisible] = useState(false);
  const [portraitVisible, setPortraitVisible] = useState(false);
  const [checking, setChecking] = useState(false);
  const [conversation] = useState(() => createDigitalTwinConversation((request, signal) => {
    const apiBaseUrl = resolveDigitalTwinApiBaseUrl();
    const local = apiBaseUrl && ["localhost", "127.0.0.1"].includes(new URL(apiBaseUrl).hostname);
    return requestDigitalTwinAnswer(request, signal, local ? undefined : async () => {
      const container = document.getElementById("twin-turnstile");
      if (!TURNSTILE_SITE_KEY || !container) {
        throw new Error("The security check is temporarily unavailable. Please try again later.");
      }
      setChecking(true);
      try {
        return await getDigitalTwinChallenge(container, TURNSTILE_SITE_KEY, signal);
      } finally {
        if (!signal.aborted) setChecking(false);
      }
    });
  }, WELCOME_MESSAGE));
  const { messages, loading, error, canRetry } = useSyncExternalStore(
    conversation.subscribe, conversation.getSnapshot, conversation.getSnapshot,
  );
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  function close() {
    conversation.cancel();
    setChecking(false);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;

    const launcher = launcherRef.current;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 80);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        conversation.cancel();
        setChecking(false);
        setOpen(false);
        return;
      }

      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"])',
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
  }, [open, conversation]);

  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, loading, error, open]);

  useEffect(() => () => conversation.cancel(), [conversation]);

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

  const submitQuestion = (question: string) => {
    if (!question.trim() || conversation.getSnapshot().loading) return;
    setDraft("");
    void conversation.submit(question);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitQuestion(draft);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitQuestion(draft);
    }
  };

  const startNewConversation = () => {
    conversation.reset();
    setChecking(false);
    setDraft("");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const launcherObscured = contactVisible && !open;

  return (
    <div className={`digital-twin${open ? " is-open" : ""}${launcherObscured ? " contact-visible" : ""}${heroActionsVisible ? " hero-actions-visible" : ""}${portraitVisible ? " portrait-visible" : ""}`}>
      {open && <button className="twin-backdrop" aria-label="Close Digital Twin" onClick={close} />}

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
              <button className="twin-close" type="button" aria-label="Close Digital Twin" onClick={close}>×</button>
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
                  <button type="button" key={question} disabled={loading} onClick={() => submitQuestion(question)}>
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
                {canRetry && <button type="button" onClick={() => void conversation.retry()}>Retry</button>}
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="twin-challenge">
            {checking && <p role="status">Verifying your request…</p>}
            <div id="twin-turnstile" />
          </div>

          <form className="twin-composer" onSubmit={handleSubmit}>
            <label htmlFor="twin-question" className="sr-only">Ask a professional question</label>
            <textarea
              ref={inputRef}
              id="twin-question"
              value={draft}
              maxLength={MAX_QUESTION_UNITS}
              rows={2}
              disabled={loading}
              placeholder="Ask about experience, architecture, payments, or leadership…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleInputKeyDown}
            />
            <button type="submit" disabled={loading || !draft.trim()} aria-label="Send question">↑</button>
          </form>

          <p className="twin-disclosure" id="twin-disclosure">
            This is an AI representation of JC. OpenRouter and its model provider process your question and relevant conversation context.
            Usage metadata may be retained. Please avoid sensitive information. <a href="mailto:jcquevedo84@gmail.com">Privacy questions</a>
          </p>
        </aside>
      )}
    </div>
  );
}
