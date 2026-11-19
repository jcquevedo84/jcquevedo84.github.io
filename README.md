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

Static verification checks public content and root-relative assets, private paths and document markers, backend-only variable names, and credential values explicitly supplied in the process environment. It expects the launcher and V2 client bundle by default. In disabled mode it checks exported HTML, route payloads, and JavaScript for chat markup and API references. It never reads `.env` and reports counts only. CI uses synthetic credential values and an inert public API URL. The separate OpenRouter diagnostic is a live check outside the gate.

`npm run diagnose:openrouter` makes one minimal Chat Completions request using the exact configured model, a redacted prompt, and a 16-token output limit. It recognizes `openrouter/free` and model identifiers ending in `:free` as zero-cost; every other identifier is refused unless the separate, explicit `--allow-paid` flag is supplied. The command never prints credentials, prompts, professional knowledge, or completion content.

To enable structured backend diagnostics temporarily, start the API with `OPENROUTER_DEBUG=true`. Diagnostics are disabled by default. Request message content is replaced with `[REDACTED]`; response content is never logged. Logs include correlation IDs, request shape and size, upstream HTTP status, safe headers, sanitized provider errors, and transport failure categories. Do not enable debug logging as a substitute for production observability or persist the console output without an appropriate retention policy.

Production chat requests default to `OPENROUTER_MAX_COMPLETION_TOKENS=1500`; configuration is bounded to a maximum of 2000. This budget includes reasoning tokens for models that use them, so a larger limit does not guarantee visible output. Safe debug metadata includes the requested and actual models, finish reason, prompt/completion/reasoning token counts when supplied by OpenRouter, visible text length, and whether the result appears truncated. Responses ending because of a token limit, reasoning-only responses, and unsupported content structures are rejected with a sanitized retryable error. Retry remains a manual visitor action; the backend does not make automatic repeat or fallback requests.

`npm run build` writes the GitHub Pages-compatible static site to `out/`. The static site does not require a Next.js server. `npm run preview` serves the existing `out/` directory on port 3000.

## Architecture

1. `app/` and `components/` contain the statically exported portfolio and browser-only chat interface.
2. `server/` contains the standalone API, curated public-safe professional knowledge, prompt policy, request validation, rate limiting, CORS handling, and the OpenRouter client.
3. When the widget is enabled, the browser calls `NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL`. This value is public and contains no credential. When unset on localhost, the browser uses the same hostname on port 8787. A future public build with the widget enabled must set the deployed HTTPS API URL explicitly.
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

## GitHub Pages release

The Pages workflow builds the domain-root site with `NEXT_PUBLIC_DIGITAL_TWIN_ENABLED=false`, runs the full verification gate, and uploads the same verified `out/` directory. The build skips the widget import and leaves its browser code out of the export. Pages serves the artifact directly and preserves `_next/` without a Jekyll build. The portfolio runs without a Next.js server or a Digital Twin API.

To preview the public build with the pinned toolchain from a clean checkout:

```bash
nvm use
npm ci
NEXT_PUBLIC_DIGITAL_TWIN_ENABLED=false npm run verify
npm run preview
```

Leave the flag unset for local development and CI validation with the widget. When rechecking an existing disabled export, run `NEXT_PUBLIC_DIGITAL_TWIN_ENABLED=false npm run verify:static` before rebuilding in another mode.

### Configure publishing and verify the release

1. Before switching the publishing source, record the current source and the latest successful deployment. The live site checked during P01 was titled **SpaceX Platzi** and used **Deploy from a branch**, `master`, and `/ (root)`. Publishing the portfolio replaces the site at the same URL.
2. In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**. Keep the custom domain unset and HTTPS enabled.
3. In **Settings → Environments → github-pages**, ensure **Deployment branches and tags** permits `feature/professional-portfolio`. If it does not, select **Selected branches and tags** and add a **Branch** rule for that exact name. Preserve existing reviewer requirements and any other required rules.
4. Push the reviewed commit to `feature/professional-portfolio`. The Pages workflow runs on pushes to this branch. In **Actions**, check that both the build and deployment jobs succeeded for the reviewed commit. Open the environment URL and confirm the portfolio, portrait, navigation, and contact links load. In the browser’s Network panel, reload and confirm the root-relative CSS, JavaScript, and portrait load and there are no Digital Twin requests.

### Rollback

For the first release, cancel any pending Pages workflow runs and restore **Settings → Pages → Source → Deploy from a branch**, with branch `master` and folder `/ (root)`. Save and confirm that GitHub reports a successful Pages deployment and that the root URL again serves **SpaceX Platzi**. If the previous source recorded before release differs, restore those recorded settings instead. For later portfolio-only recovery, restore the last approved portfolio code on the release branch through a reviewed change and redeploy through the same gate with the widget disabled.

## Future Digital Twin deployment

Once the public API protections are ready, review the Pages workflow and the standalone API deployment together. For a local preview of a future enabled production configuration, use a deployed HTTPS API URL:

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
