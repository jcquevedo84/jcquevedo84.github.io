import {
  CONVERSATION_ID_PATTERN,
  ConversationContextError,
  MAX_CONTINUATION_BYTES,
  REQUEST_LIMITS,
} from "./validation.mjs";

const VERSION = 1;
const PURPOSE = "digital-twin-chat";
const TOKEN_TTL_MS = 30 * 60 * 1_000;
const MAX_EXCHANGES = 2;
const MAX_ASSISTANT_UNITS = 1_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function signingKeyBytes(value) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2}){32,64}$/i.test(value)) return null;
  const bytes = Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
  // A length check alone would accept obvious placeholders and repeated patterns.
  return new Set(bytes).size >= 16 ? bytes : null;
}

function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(encoded) {
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  if (encodeBase64Url(bytes) !== encoded) throw new ConversationContextError();
  return bytes;
}

function isContextText(value, maximumUnits) {
  return typeof value === "string" && value.length <= maximumUnits && Boolean(value.trim())
    && !/\p{Surrogate}/u.test(value);
}

function isExchange(value) {
  return value !== null && typeof value === "object"
    && Object.keys(value).length === 2
    && isContextText(value.question, REQUEST_LIMITS.maximumMessageCharacters)
    && isContextText(value.answer, MAX_ASSISTANT_UNITS);
}

function isState(value, id) {
  return value !== null && typeof value === "object"
    && Object.keys(value).length === 5 && value.version === VERSION && value.purpose === PURPOSE
    && value.id === id && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0
    && Array.isArray(value.exchanges) && value.exchanges.length <= MAX_EXCHANGES
    && value.exchanges.every(isExchange);
}

function assistantExcerpt(text) {
  if (text.length <= MAX_ASSISTANT_UNITS) return text;
  if (typeof Intl.Segmenter !== "function") return "";

  let end = 0;
  for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (index + segment.length >= MAX_ASSISTANT_UNITS) break;
    end = index + segment.length;
  }
  return end ? `${text.slice(0, end).trimEnd()}…` : "";
}

export function toConversationExchange(question, answer) {
  const exchange = { question, answer: assistantExcerpt(answer) };
  return isExchange(exchange) ? exchange : null;
}

export async function createConversationContext(signingKey, { now = Date.now } = {}) {
  const bytes = signingKeyBytes(signingKey);
  if (!bytes) return null;

  const subtle = globalThis.crypto?.subtle;
  let key;
  try {
    key = await subtle?.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  } catch {
    return null;
  }
  if (!key) return null;

  return {
    newId() {
      return globalThis.crypto.randomUUID();
    },

    async verify({ id, token }) {
      if (typeof id !== "string" || !CONVERSATION_ID_PATTERN.test(id)
        || typeof token !== "string" || token.length > MAX_CONTINUATION_BYTES) {
        throw new ConversationContextError();
      }
      const parts = token.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
      if (!parts) throw new ConversationContextError();
      const [, encoded, signature] = parts;

      let state;
      try {
        const authenticated = await subtle.verify("HMAC", key, decodeBase64Url(signature), encoder.encode(encoded));
        if (!authenticated) throw new ConversationContextError();
        state = JSON.parse(decoder.decode(decodeBase64Url(encoded)));
      } catch {
        throw new ConversationContextError();
      }
      if (!isState(state, id)) throw new ConversationContextError();
      if (state.expiresAt <= now()) throw new ConversationContextError(true);
      return state.exchanges;
    },

    async issue(id, exchanges) {
      if (typeof id !== "string" || !CONVERSATION_ID_PATTERN.test(id)) throw new ConversationContextError();
      const expiresAt = now() + TOKEN_TTL_MS;
      const recent = exchanges.slice(-MAX_EXCHANGES);
      if (!recent.every(isExchange)) throw new ConversationContextError();
      let encoded;
      for (;;) {
        encoded = encodeBase64Url(encoder.encode(JSON.stringify({
          version: VERSION, purpose: PURPOSE, id, expiresAt, exchanges: recent,
        })));
        if (encoded.length + 44 <= MAX_CONTINUATION_BYTES) break;
        recent.shift();
      }
      const signature = await subtle.sign("HMAC", key, encoder.encode(encoded));
      return { id, token: `${encoded}.${encodeBase64Url(new Uint8Array(signature))}` };
    },
  };
}
