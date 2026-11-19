# Juan Carlos Rodríguez Quevedo Professional Portfolio

Static Next.js portfolio with an independent AI-powered professional Digital Twin. The frontend is compatible with GitHub Pages; the AI API is a separate Node.js service and must be deployed to an environment that can protect `OPENROUTER_API_KEY`.

## Local development

Use the project toolchain before installing dependencies. With NVM, run from the repository root:

```bash
nvm install
nvm use
node --version  # v24.22.3
npm --version   # 11.19.1
npm ci
```

`.nvmrc` selects the Node version for the current shell with `nvm use`. Node 24.22.3 includes npm 11.19.1. Use `npm ci` for clean installs from the committed lockfile.

The existing `.env` file is read by the backend and must not be committed or uploaded. Use `.env.example` only as a variable reference. Both `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are required; the backend will not silently substitute a model.

```bash
# Frontend and Digital Twin API together
npm run dev

# Or run them separately
npm run dev:frontend
npm run dev:api
```

The V2 Digital Twin also needs a dedicated conversation signing key. To start both services locally without changing `.env`, run these commands in separate terminals. The first command generates a new key and passes it only to the backend process.

```bash
# Terminal 1 — backend
DIGITAL_TWIN_CONVERSATION_SIGNING_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" npm run dev:api

# Terminal 2 — frontend
npm run dev:frontend
```

The signing key must contain 32–64 cryptographically random bytes encoded as hexadecimal. A missing key, malformed value, obvious placeholder, or value shared with the OpenRouter API key leaves V2 unavailable with a sanitized 503. The backend can check the encoding, length, and obvious patterns. CSPRNG generation supplies the actual entropy. The command above creates a new key every time you run it, so continuations from an earlier run need a fresh Retry.

- Portfolio: `http://localhost:3000`
- Digital Twin API: `http://localhost:8787`
- Health check: `http://localhost:8787/health`

The combined command checks ports 3000 and 8787 first and stops without killing an existing process when either port is occupied.

## Validation and static preview

```bash
npm run verify
npm run preview
```

For release-equivalent validation, run `npm ci` and `npm run verify` in a clean checkout with the pinned toolchain. The gate runs ESLint, generates Next.js route types, checks TypeScript, runs mock-only tests, builds the static site, and verifies the fresh `out/` directory. Builds also run Next.js's own TypeScript check.

Static verification checks public assets, the V2 client bundle, private paths and document markers, backend-only variable names, and credential values explicitly supplied in the process environment. It never reads `.env` and reports counts only. CI uses synthetic credential values and an inert public API URL. The separate OpenRouter diagnostic is a live check outside the gate.

`npm run diagnose:openrouter` makes one minimal Chat Completions request using the exact configured model, a redacted prompt, and a 16-token output limit. It recognizes `openrouter/free` and model identifiers ending in `:free` as zero-cost; every other identifier is refused unless the separate, explicit `--allow-paid` flag is supplied. The command never prints credentials, prompts, professional knowledge, or completion content.

To enable structured backend diagnostics temporarily, start the API with `OPENROUTER_DEBUG=true`. Diagnostics are disabled by default. Request message content is replaced with `[REDACTED]`; response content is never logged. Logs include correlation IDs, request shape and size, upstream HTTP status, safe headers, sanitized provider errors, and transport failure categories. Do not enable debug logging as a substitute for production observability or persist the console output without an appropriate retention policy.

Production chat requests default to `OPENROUTER_MAX_COMPLETION_TOKENS=1500`; configuration is bounded to a maximum of 2000. This budget includes reasoning tokens for models that use them, so a larger limit does not guarantee visible output. Safe debug metadata includes the requested and actual models, finish reason, prompt/completion/reasoning token counts when supplied by OpenRouter, visible text length, and whether the result appears truncated. Responses ending because of a token limit, reasoning-only responses, and unsupported content structures are rejected with a sanitized retryable error. Retry remains a manual visitor action; the backend does not make automatic repeat or fallback requests.

`npm run build` writes the GitHub Pages-compatible static site to `out/`. The static site does not require a Next.js server. `npm run preview` serves the existing `out/` directory on port 3000.

## Architecture

1. `app/` and `components/` contain the statically exported portfolio and browser-only chat interface.
2. `server/` contains the standalone API, curated public-safe professional knowledge, prompt policy, request validation, rate limiting, CORS handling, and the OpenRouter client.
3. The browser calls `NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL`. This value is public and contains no credential. When unset on localhost, the browser uses the same hostname on port 8787. Production builds must set the deployed HTTPS API URL explicitly.
4. The backend reads `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`, then calls `https://openrouter.ai/api/v1/chat/completions` with that exact configured model. Neither variable is returned to the browser.

The original professional documents remain under ignored `resource/` storage and are not read at runtime, copied into the static site, or sent to OpenRouter. The backend sends only topic-selected sections from a curated public-safe knowledge representation.

### Chat API and conversation history

- `POST /v1/chat` keeps its existing `{ messages }` request and `{ message }` success response. It validates the whole legacy request against the original limits, then sends only the latest user question to the model. Older callers have single-turn behavior.
- `POST /v2/chat` accepts `{ question }` for a new conversation or `{ question, conversation: { id, token } }` to continue. It returns `{ message, conversation: { id, token } }`. The backend verifies the HMAC-SHA-256 signature, version, purpose, conversation ID, expiry, and bounded history before using earlier turns. Bad or mismatched state returns `400 invalid_conversation_context`. Authenticated expired state returns `409 conversation_context_expired`. In either case, Retry sends the same question with fresh context and keeps the prior messages visible.
- The widget keeps full displayed answers in memory. A continuation retains at most two completed exchanges, with each prior assistant excerpt capped at 1,000 UTF-16 units on grapheme boundaries. The token is capped at 10,000 bytes. The 2,000-unit question limit and 24,000-byte HTTP request limit still apply. New Conversation clears the local transcript and continuation and aborts the active request.

Continuations are readable bearer data. They contain a limited amount of visitor text and assistant output, so avoid submitting sensitive information. The application keeps them out of URLs, persistent browser storage, and logs, and excludes recognized sensitive material from retained history. The backend treats earlier replies as context about the conversation. The curated profile remains the source of professional facts.

A valid continuation can be replayed or used to branch a conversation until it expires, 30 minutes after issuance. The signature provides integrity. It does not provide encryption, visitor authentication, single-use enforcement, or per-conversation revocation. Manual Retry avoids duplicate displayed turns, though a retry after a lost response may invoke the model again.

## Professional portrait

The approved navy collared-shirt portrait is integrated into the About section from `public/jcquevedo84-linkedin.jpg`. The public copy is a web-optimized, metadata-free JPEG; the original source photograph remains outside the project and unchanged.

## Local safeguards

- Explicit origin allowlist.
- Input, history, request-body, and output limits.
- Upstream timeout and sanitized errors.
- Opt-in, redacted OpenRouter HTTP diagnostics with upstream/local status separation.
- In-memory per-address rate limiting.
- No conversation-body or credential logging.
- Local refusal for common instruction/secret extraction attempts.
- Strict professional scope and missing-information behavior in the system prompt.

These controls reduce risk but do not guarantee prompt-injection prevention. Before public deployment, use trusted proxy configuration, durable/distributed rate limiting, managed secret storage, abuse monitoring, appropriate provider budget limits, operational alerting, and a reviewed privacy notice. CORS limits browser origins but is not authentication.

## Future deployment configuration

The CI workflow validates the build. For a future Pages release, publish only the verified contents of `out/` and keep the independent Digital Twin backend deployed separately. The current paths assume the site is hosted at the domain root. If branch publishing is selected, preserve `_next/` by adding `.nojekyll` to the publish root.

For `jcquevedo84.github.io`, build the frontend with an HTTPS API URL:

```bash
NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL=https://api.example.com npm run build
```

Configure the backend allowlist with the public portfolio origins:

```text
DIGITAL_TWIN_ALLOWED_ORIGINS=https://jcquevedo84.github.io,https://jcquevedo84.com
```

Configure `OPENROUTER_API_KEY` as a secret in the independently deployed backend and `OPENROUTER_MODEL` as a backend environment variable. Do not upload the local `.env` file to GitHub Pages or any source repository; GitHub Pages receives only the static frontend and cannot safely hold either value.

Provision `DIGITAL_TWIN_CONVERSATION_SIGNING_KEY` in the backend's managed secret store. Use a dedicated random key per environment and share that environment's key across its backend replicas. Keep the key out of frontend build variables, source control, and logs. Provision the V2-capable backend before publishing the updated static frontend. Rotation makes outstanding tokens fail verification, and visitors can Retry without earlier context. If the frontend needs to roll back, keep the hardened V1 backend behavior so older clients continue using latest-question-only inference.

The backend HTTP adapter currently targets Node.js. The knowledge selection, validation, prompt, and OpenRouter modules use portable JavaScript/fetch boundaries so a future Cloudflare Worker deployment can replace only the HTTP/environment adapter.
