import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import miniflare from "miniflare";
import { OPENROUTER_URL } from "./config.mjs";
import { SITEVERIFY_URL } from "./turnstile.mjs";

const { Miniflare } = miniflare;
const root = fileURLToPath(new URL("../", import.meta.url));
export const runtimeConfig = JSON.parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
export const stagingConfig = JSON.parse(await readFile(join(root, "wrangler.staging.jsonc"), "utf8"));
const modulePaths = [
  runtimeConfig.main,
  stagingConfig.main,
  "worker/admission.mjs",
  "worker/config.mjs",
  "worker/turnstile.mjs",
  "server/chat-service.mjs",
  "server/config.mjs",
  "server/conversation-context.mjs",
  "server/http-errors.mjs",
  "server/knowledge-base.mjs",
  "server/openrouter-client.mjs",
  "server/openrouter-diagnostics.mjs",
  "server/prompt.mjs",
  "server/security.mjs",
  "server/validation.mjs",
];
const modules = Object.fromEntries(await Promise.all(modulePaths.map(async (path) => [
  path, { type: "esm", contents: await readFile(join(root, path), "utf8") },
])));
const clockFixture = `
  export { default } from "./worker/index.mjs";
  import { InferenceAdmission as Admission } from "./worker/admission.mjs";
  export class InferenceAdmission extends Admission {
    constructor(ctx, env) {
      super(ctx, env, () => this.testClock ?? Date.now());
    }
    setClock(value) { this.testClock = value; }
    delayNextGrant(ms) { this.grantDelay = ms; }
    async admit(digest) {
      const result = await super.admit(digest);
      if (result.outcome === "admitted" && this.grantDelay) {
        const delay = this.grantDelay;
        this.grantDelay = 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return result;
    }
    async runCleanup() { await this.alarm(); }
    countReads() {
      return this.ctx.storage.sql.exec(
        "SELECT COUNT(*) FROM challenge_claims WHERE expires_at > ?", this.testClock ?? Date.now()
      ).rowsRead;
    }
  }
`;

export const origin = runtimeConfig.vars.DIGITAL_TWIN_ALLOWED_ORIGINS;
export const providerKey = "worker-test-provider-canary";
export const turnstileKey = "worker-test-turnstile-canary";
export const providerModel = "synthetic/test-model:free";
export const providerName = "synthetic-zero-retention-provider";

export function chatHeaders(token = randomUUID()) {
  return {
    Origin: origin,
    "Content-Type": "application/json",
    "X-Digital-Twin-Challenge": token,
    "CF-Connecting-IP": "192.0.2.10",
    // Consumed by workerd's direct local test socket to simulate Cloudflare metadata.
    "MF-CF-Blob": JSON.stringify({ colo: "TEST" }),
  };
}

export function jsonResponse(response, body, status = 200, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

export function completion(content) {
  return { choices: [{ message: { content }, finish_reason: "stop" }] };
}

export function verification(fields = {}) {
  return {
    success: true,
    hostname: runtimeConfig.vars.TURNSTILE_EXPECTED_HOSTNAME,
    action: runtimeConfig.vars.TURNSTILE_EXPECTED_ACTION,
    challenge_ts: new Date().toISOString(),
    ...fields,
  };
}

export async function startWorker(t, {
  bindings = {},
  config = runtimeConfig,
  accessAudience,
  omit = [],
  controlledClock = false,
  persistencePath,
  rateLimit = config.ratelimits[0].simple.limit,
  mock = (response) => jsonResponse(response, completion("Synthetic reply.")),
  mockVerification = (response) => jsonResponse(response, verification()),
} = {}) {
  const calls = [];
  const verifications = [];
  const logs = [];
  let rejectedOutboundRequests = 0;
  const signingKey = randomBytes(32).toString("hex");
  const variables = {
    ...config.vars,
    ...(config === runtimeConfig && { DIGITAL_TWIN_INFERENCE_ENABLED: "true" }),
    DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: signingKey,
    OPENROUTER_API_KEY: providerKey,
    OPENROUTER_MODEL: providerModel,
    OPENROUTER_ALLOWED_PROVIDERS: providerName,
    OPENROUTER_TIMEOUT_MS: "3000",
    TURNSTILE_SECRET_KEY: turnstileKey,
    ...bindings,
  };
  const rateBinding = config.ratelimits[0];
  const admissionBinding = config.durable_objects.bindings[0];
  const env = {
    ...Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, { type: "text", value }])),
    [rateBinding.name]: {
      type: "rate-limit",
      namespace: rateBinding.namespace_id,
      simple: { ...rateBinding.simple, limit: rateLimit },
    },
    [admissionBinding.name]: {
      type: "durable-object",
      worker: config.name,
      exportName: admissionBinding.class_name,
    },
  };
  for (const name of omit) delete env[name];

  async function handleOutbound(request, response) {
    const url = new URL(request.url, `https://${request.headers.host}`).href;
    if (![OPENROUTER_URL, SITEVERIFY_URL].includes(url) || request.method !== "POST") {
      rejectedOutboundRequests += 1;
      response.writeHead(502).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks)) };
      if (url === OPENROUTER_URL) {
        calls.push(call);
        mock(response, calls.length, call);
      } else {
        verifications.push(call);
        mockVerification(response, verifications.length, call);
      }
    } catch {
      response.destroy();
    }
  }

  const mainModule = controlledClock ? "fixture-entry.mjs" : config.main;
  const workerd = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    unsafeInspectDurableObjects: controlledClock,
    resourcePersistencePath: persistencePath,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    handleStructuredLogs: (entry) => logs.push(entry),
    workers: [{
      config: {
        name: config.name,
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        ...(accessAudience && { access: { dev: { aud: accessAudience } } }),
        manifest: {
          mainModule,
          modulesRoot: root,
          modules: controlledClock ? { ...modules, [mainModule]: { type: "esm", contents: clockFixture } } : modules,
        },
        exports: config.exports,
        env,
      },
      dev: {
        outboundService: { type: "node-handler", handler: handleOutbound },
        unsafeDirectSockets: [{ host: "127.0.0.1", port: 0 }],
      },
    }],
  });
  let disposal;
  const stop = () => disposal ??= workerd.dispose();
  t.after(stop);
  const url = await workerd.unsafeGetDirectURL();
  const fetchRoute = (path, init) => fetch(new URL(path, url), init);
  const chat = (payload, headers = chatHeaders()) => fetchRoute("/v2/chat", {
    method: "POST", headers, body: JSON.stringify(payload),
  });

  return {
    workerd, stop, url, calls, verifications, logs, fetchRoute, chat, signingKey,
    get rejectedOutboundRequests() { return rejectedOutboundRequests; },
  };
}
