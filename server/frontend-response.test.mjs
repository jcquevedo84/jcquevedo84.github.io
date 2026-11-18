import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { requestDigitalTwinAnswer } from "../lib/digital-twin-api.ts";

test("frontend API client preserves the complete backend answer without truncation", async () => {
  const previousBaseUrl = process.env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL;
  const previousFetch = globalThis.fetch;
  const completeAnswer = [
    "Formal education: Ingeniería de Sistemas.",
    "Postgraduate education: Maestría en Ingeniería de Sistemas.",
    "Current learning: AI-assisted coding and Blockchain/Web3 training.",
  ].join("\n\n");

  process.env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL = "https://api.test.invalid";
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { role: "assistant", content: completeAnswer },
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const answer = await requestDigitalTwinAnswer([{ role: "user", content: "Education and learning?" }]);
    assert.equal(answer, completeAnswer);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBaseUrl === undefined) delete process.env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL;
    else process.env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL = previousBaseUrl;
  }
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
