# Juan Carlos Rodríguez Quevedo Professional Portfolio

Static Next.js portfolio with an independent AI-powered professional Digital Twin. The frontend is compatible with GitHub Pages; the AI API is a separate Node.js service and must be deployed to an environment that can protect `OPENROUTER_API_KEY`.

## Local development

The existing `.env` file is read by the backend and must not be committed or uploaded. Use `.env.example` only as a variable reference. Both `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are required; the backend will not silently substitute a model.

```bash
# Frontend and Digital Twin API together
npm run dev

# Or run them separately
npm run dev:frontend
npm run dev:api
```

- Portfolio: `http://localhost:3000`
- Digital Twin API: `http://localhost:8787`
- Health check: `http://localhost:8787/health`

The combined command checks ports 3000 and 8787 first and stops without killing an existing process when either port is occupied.

## Validation and static preview

```bash
npm run lint
npm run typecheck
npm run test:api
npm run diagnose:openrouter
npm run build
npm run preview
```

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

For `jcquevedo84.github.io`, build the frontend with an HTTPS API URL:

```bash
NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL=https://api.example.com npm run build
```

Configure the backend allowlist with the public portfolio origins:

```text
DIGITAL_TWIN_ALLOWED_ORIGINS=https://jcquevedo84.github.io,https://jcquevedo84.com
```

Configure `OPENROUTER_API_KEY` as a secret in the independently deployed backend and `OPENROUTER_MODEL` as a backend environment variable. Do not upload the local `.env` file to GitHub Pages or any source repository; GitHub Pages receives only the static frontend and cannot safely hold either value.

The backend HTTP adapter currently targets Node.js. The knowledge selection, validation, prompt, and OpenRouter modules use portable JavaScript/fetch boundaries so a future Cloudflare Worker deployment can replace only the HTTP/environment adapter.
