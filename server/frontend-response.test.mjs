import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DigitalTwinApiError, requestDigitalTwinAnswer } from "../lib/digital-twin-api.ts";
import { createDigitalTwinConversation } from "../lib/digital-twin-conversation.ts";
import { getDigitalTwinChallenge } from "../lib/digital-twin-turnstile.ts";

function useApiFixture(t, fetchImpl) {
  const previousBaseUrl = process.env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL = "https://api.test.invalid";
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousBaseUrl === undefined) delete process.env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL;
    else process.env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL = previousBaseUrl;
  });
}

function context(id = crypto.randomUUID(), label = "fixture") {
  return { id, token: `${label}.${"x".repeat(43)}` };
}

function answer(content, conversation = context()) {
  return { message: { role: "assistant", content }, conversation };
}

function widgetFixture() {
  const calls = [];
  const widget = createDigitalTwinConversation((request, signal) => new Promise((resolve, reject) => {
    calls.push({ request, signal, resolve, reject });
  }), "Welcome");
  return { widget, calls };
}

test("frontend API client preserves the complete backend answer without truncation", async (t) => {
  const completeAnswer = [
    "Formal education: Ingeniería de Sistemas.",
    "Postgraduate education: Maestría en Ingeniería de Sistemas.",
    "Current learning: AI-assisted coding and Blockchain/Web3 training.",
    "Respuesta completa 👩‍💻.".repeat(150),
  ].join("\n\n");
  const result = answer(completeAnswer);
  useApiFixture(t, async (url, options) => {
    assert.equal(url, "https://api.test.invalid/v2/chat");
    assert.deepEqual(JSON.parse(options.body), { question: "Education and learning?" });
    return Response.json(result);
  });
  assert.deepEqual(await requestDigitalTwinAnswer({ question: "Education and learning?" }), result);
});

test("frontend sends the latest Unicode question and bounded continuation without reserializing the transcript", async (t) => {
  const conversation = context();
  conversation.token = `${"a".repeat(9_956)}.${"x".repeat(43)}`;
  const question = "¿" + "\u0001".repeat(1_995) + "👩?";
  useApiFixture(t, async (_url, options) => {
    assert.ok(Buffer.byteLength(options.body) <= 24_000);
    assert.deepEqual(JSON.parse(options.body), { question, conversation });
    return Response.json(answer("Continuación.", { ...conversation, token: context().token }));
  });
  assert.equal((await requestDigitalTwinAnswer({ question, conversation })).message.content, "Continuación.");
});

test("a rejected public request requires a fresh Turnstile token on manual Retry", async (t) => {
  const calls = [];
  let renderCount = 0;
  const removed = [];
  const container = {};
  const hadWindow = Object.hasOwn(globalThis, "window");
  const previousWindow = globalThis.window;
  globalThis.window = {
    setTimeout,
    clearTimeout,
    turnstile: {
      render(element, options) {
        assert.equal(element, container);
        assert.equal(options.action, "digital_twin_chat");
        assert.equal(options.retry, "never");
        assert.equal(options["response-field"], false);
        const id = String(++renderCount);
        options.callback(`synthetic-${id}`);
        return id;
      },
      remove: (id) => removed.push(id),
    },
  };
  t.after(() => {
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  });
  useApiFixture(t, async (_url, options) => {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { question: "Question" });
    calls.push(options.headers["X-Digital-Twin-Challenge"]);
    return calls.length === 1
      ? Response.json({ error: { code: "provider_rate_limited", message: "PRIVATE UPSTREAM DETAIL" } }, { status: 429 })
      : Response.json(answer("Reply"));
  });
  const widget = createDigitalTwinConversation((request, signal) => requestDigitalTwinAnswer(request, signal,
    () => getDigitalTwinChallenge(container, "synthetic-site-key", signal)), "Welcome");
  await widget.submit("Question");
  assert.match(widget.getSnapshot().error, /free AI service has reached a temporary limit/);
  assert.deepEqual(calls, ["synthetic-1"]);
  await widget.retry();
  assert.deepEqual(calls, ["synthetic-1", "synthetic-2"]);
  assert.deepEqual(removed, ["1", "2"]);
  assert.deepEqual(widget.getSnapshot().messages.map(({ content }) => content), ["Welcome", "Question", "Reply"]);
});

test("cancelling a public submission while Turnstile is pending blocks the POST", async (t) => {
  useApiFixture(t, async () => assert.fail("unexpected provider request"));
  const controller = new AbortController();
  const request = requestDigitalTwinAnswer({ question: "Question" }, controller.signal, async () => {
    controller.abort();
    return "late-synthetic-challenge";
  });
  await assert.rejects(request, { name: "AbortError" });
});

test("frontend rejects malformed or mismatched response envelopes and displays a fixed expiry message", async (t) => {
  const conversation = context();
  const fixtures = [
    () => Response.json(null),
    () => Response.json({ ...answer("Reply", conversation), message: { role: "user", content: "Wrong role" } }),
    () => Response.json(answer("Reply", context())),
    () => Response.json({ error: { code: "conversation_context_expired", message: "UNTRUSTED SERVER TEXT" } }, { status: 409 }),
  ];
  useApiFixture(t, async () => fixtures.shift()());

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(requestDigitalTwinAnswer({ question: "Question", conversation }), /invalid conversation response/);
  }
  await assert.rejects(
    requestDigitalTwinAnswer({ question: "Question", conversation }),
    { code: "conversation_context_expired", message: "The conversation context expired. Retry to send your question without the earlier context." },
  );
});

test("Retry preserves the latest committed context and never duplicates the displayed user turn", async () => {
  const { widget, calls } = widgetFixture();
  const first = widget.submit("First");
  const firstContext = context();
  const longAnswer = "a".repeat(2_300);
  calls[0].resolve(answer(longAnswer, firstContext));
  await first;

  const second = widget.submit("Follow-up");
  calls[1].reject(new Error("Temporary failure"));
  await second;
  assert.equal(widget.getSnapshot().canRetry, true);

  const retry = widget.retry();
  await widget.retry();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].request, { question: "Follow-up", conversation: firstContext });
  const nextContext = context(firstContext.id, "next");
  calls[2].resolve(answer("Follow-up answer", nextContext));
  await retry;

  assert.deepEqual(widget.getSnapshot().messages.map(({ content }) => content),
    ["Welcome", "First", longAnswer, "Follow-up", "Follow-up answer"]);
  const next = widget.submit("Next");
  assert.deepEqual(calls[3].request, { question: "Next", conversation: nextContext });
  calls[3].resolve(answer("Done", nextContext));
  await next;
});

test("expired context recovers with a fresh manual Retry and keeps the displayed transcript", async () => {
  const { widget, calls } = widgetFixture();
  const first = widget.submit("First");
  calls[0].resolve(answer("Old answer"));
  await first;
  const followUp = widget.submit("Same question");
  calls[1].reject(new DigitalTwinApiError("Context expired. Retry without the earlier context.", "conversation_context_expired"));
  await followUp;
  assert.match(widget.getSnapshot().error, /without the earlier context/);
  assert.equal(calls.length, 2);

  const retry = widget.retry();
  assert.deepEqual(calls[2].request, { question: "Same question" });
  calls[2].resolve(answer("Fresh answer"));
  await retry;
  assert.deepEqual(widget.getSnapshot().messages.map(({ content }) => content),
    ["Welcome", "First", "Old answer", "Same question", "Fresh answer"]);
});

test("New Conversation aborts and ignores stale success, failure, and loading updates", async () => {
  const { widget, calls } = widgetFixture();
  for (const method of ["resolve", "reject"]) {
    const stale = widget.submit("Old question");
    const oldCall = calls.at(-1);
    widget.reset();
    assert.equal(oldCall.signal.aborted, true);
    const current = widget.submit("New question");
    const currentCall = calls.at(-1);
    assert.deepEqual(currentCall.request, { question: "New question" });
    oldCall[method](method === "resolve" ? answer("Stale response") : new Error("Stale error"));
    await stale;
    assert.equal(widget.getSnapshot().loading, true);
    assert.equal(widget.getSnapshot().error, null);
    assert.deepEqual(widget.getSnapshot().messages.map(({ content }) => content), ["Welcome", "New question"]);
    currentCall.resolve(answer("New answer"));
    await current;
    widget.reset();
  }
});

test("cancellation keeps the pending question retryable and discards late continuation state", async () => {
  const { widget, calls } = widgetFixture();
  const initial = widget.submit("Pending question");
  widget.cancel();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(widget.getSnapshot().loading, false);
  assert.equal(widget.getSnapshot().canRetry, true);
  calls[0].resolve(answer("Late result"));
  await initial;
  const retry = widget.retry();
  assert.deepEqual(calls[1].request, { question: "Pending question" });
  calls[1].resolve(answer("Current result"));
  await retry;
  assert.deepEqual(widget.getSnapshot().messages.map(({ content }) => content), ["Welcome", "Pending question", "Current result"]);
});

test("frontend message rendering preserves whitespace and has no line clamp", async () => {
  const [component, styles] = await Promise.all([
    readFile("components/DigitalTwin.tsx", "utf8"),
    readFile("app/globals.css", "utf8"),
  ]);

  assert.match(component, /<p>\{message\.content\}<\/p>/);
  const messageRule = styles.match(/\.twin-message p\s*\{[^}]+\}/s)?.[0] || "";
  assert.match(messageRule, /white-space:\s*pre-wrap/);
  assert.doesNotMatch(messageRule, /line-clamp|text-overflow|max-height|overflow:\s*hidden/);
});
