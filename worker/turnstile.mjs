export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 16_384;
const MAX_CHALLENGE_AGE_MS = 300_000;
const CLOCK_SKEW_MS = 5_000;

export function isFreshChallenge(issuedAt, now) {
  return Number.isSafeInteger(issuedAt) && issuedAt > now - MAX_CHALLENGE_AGE_MS && issuedAt <= now + CLOCK_SKEW_MS;
}

export function isChallengeToken(token) {
  return typeof token === "string" && token.length > 0 && token.length <= 2_048 && !/[^\x21-\x7e]|,/.test(token);
}

async function readVerification(response, signal) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let bytes = 0;
  let complete = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        complete = true;
        return JSON.parse(body + decoder.decode());
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return null;
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export async function verifyTurnstile(token, { secret, hostname, action }, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, SITEVERIFY_TIMEOUT_MS);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { outcome: "unavailable" };
    }
    const result = await readVerification(response, controller.signal);
    if (result?.success === true) {
      if (result.hostname !== hostname || result.action !== action) return { outcome: "invalid" };
      const issuedAt = typeof result.challenge_ts === "string" ? Date.parse(result.challenge_ts) : NaN;
      return isFreshChallenge(issuedAt, Date.now()) ? { outcome: "verified", issuedAt } : { outcome: "expired" };
    }
    if (result?.success !== false || !Array.isArray(result["error-codes"])) return { outcome: "unavailable" };
    const codes = result["error-codes"];
    if (codes.some((code) => ["internal-error", "invalid-input-secret", "missing-input-secret"].includes(code))) {
      return { outcome: "unavailable" };
    }
    return { outcome: codes.includes("timeout-or-duplicate") ? "expired" : "invalid" };
  } catch {
    signal.throwIfAborted();
    return { outcome: "unavailable" };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
