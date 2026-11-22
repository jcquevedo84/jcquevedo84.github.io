import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { professionalContact } from "../lib/contact.ts";

const verifier = fileURLToPath(new URL("./verify-static-output.mjs", import.meta.url));
const openRouterMarker = "static-test-provider-canary";
const signingMarker = "static-test-signing-canary";

async function fixture(t, digitalTwinEnabled = true) {
  const cwd = await mkdtemp(join(tmpdir(), "portfolio-static-check-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  async function write(path, content) {
    const filename = join(cwd, "out", path);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }

  const indexHtml = `<title>Professional portfolio</title><meta name="description" content="Portfolio" />
    <link rel="stylesheet" href="/_next/static/app.css" /><script src="/_next/static/app.js?v=1"></script>
    <a href="#main">Skip to content</a><main id="main">
    ${["top", "about", "expertise", "experience", "portfolio", "education", "contact"].map((id) => `<section id="${id}"></section>`).join("")}
    <summary>Earlier Career — The Foundations</summary><img src="/jcquevedo84-linkedin.jpg" alt="Portrait" />
    <p>${professionalContact.email} ${professionalContact.phoneDisplay}</p>
    ${[professionalContact.mailtoUrl, professionalContact.gmailUrl, professionalContact.whatsappUrl, professionalContact.linkedinUrl].map((url) => `<a href="${url}">Contact</a>`).join("")}
    </main>${digitalTwinEnabled ? '<button class="twin-launcher">Digital Twin</button>' : ""}`;
  await write("index.html", indexHtml);
  await write("icon.svg", "<svg/>");
  await write("jcquevedo84-linkedin.jpg", "image fixture");
  await write("_next/static/app.css", ".twin-launcher { color: white; }");
  await write("_next/static/app.js", digitalTwinEnabled ? 'const endpoint = "/v2/chat";' : 'console.log("portfolio");');

  function verify(env = {}) {
    const result = spawnSync(process.execPath, [verifier], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_DIGITAL_TWIN_ENABLED: digitalTwinEnabled ? "" : "false",
        OPENROUTER_API_KEY: "",
        DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: "",
        TURNSTILE_SECRET_KEY: "",
        ...env,
      },
    });
    assert.ifError(result.error);
    return result;
  }

  return { cwd, write, verify };
}

test("static verification passes with a complete export and requires no credential values", async (t) => {
  const { verify } = await fixture(t);
  const result = verify();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^credential_values_provided=0$/m);
  assert.match(result.stdout, /^static_privacy_check=PASS$/m);
});

test("static verification distinguishes backend variable names from leaked values and patterns", async (t) => {
  const { write, verify } = await fixture(t);
  await write("names.txt", "OPENROUTER_API_KEY DIGITAL_TWIN_CONVERSATION_SIGNING_KEY TURNSTILE_SECRET_KEY");
  const namesOnly = verify();
  assert.equal(namesOnly.status, 1);
  assert.match(namesOnly.stdout, /^server_only_name_matches=1$/m);
  assert.match(namesOnly.stdout, /^credential_value_matches=0$/m);

  await write("provider.txt", openRouterMarker);
  await write("signing.txt", signingMarker);
  await write("turnstile.txt", "static-test-turnstile-canary");
  await write("pattern.txt", "sk-or-v1-synthetic-privacy-test");
  const secrets = verify({
    OPENROUTER_API_KEY: openRouterMarker,
    DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: signingMarker,
    TURNSTILE_SECRET_KEY: "static-test-turnstile-canary",
  });
  assert.equal(secrets.status, 1);
  assert.match(secrets.stdout, /^credential_values_provided=3$/m);
  assert.match(secrets.stdout, /^credential_value_matches=3$/m);
  assert.match(secrets.stdout, /^credential_pattern_matches=1$/m);
  assert.doesNotMatch(secrets.stdout + secrets.stderr, /static-test-(?:provider|signing|turnstile)-canary|sk-or-v1-synthetic-privacy-test/);
});

test("static verification rejects private paths, documents, and filesystem links", async (t) => {
  const { cwd, write, verify } = await fixture(t);
  await write(".env.local", "fixture");
  await write(".dev.vars.local", "fixture");
  await write(".wrangler/state/file", "fixture");
  await write("worker/index.mjs", "fixture");
  await write("nested/resource/private.txt", "fixture");
  await write("server/index.mjs", "fixture");
  await write("node_modules/package/index.js", "fixture");
  await write("nested/notes.PDF", "fixture");
  await write("nested/editorial.txt", "BORRADOR EDITORIAL PRIVADO");
  await symlink("icon.svg", join(cwd, "out", "link.svg"));
  await writeFile(join(cwd, "external.txt"), "outside fixture");
  await link(join(cwd, "external.txt"), join(cwd, "out", "hardlink.txt"));
  const result = verify();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^private_paths=7$/m);
  assert.match(result.stdout, /^private_document_files=1$/m);
  assert.match(result.stdout, /^unsafe_entries=2$/m);
  assert.match(result.stdout, /^forbidden_content_matches=1$/m);
});

test("static verification rejects missing public assets, broken Next references, and missing V2 client", async (t) => {
  const { cwd, write, verify } = await fixture(t);
  await rm(join(cwd, "out", "jcquevedo84-linkedin.jpg"));
  await rm(join(cwd, "out", "_next", "static", "app.js"));
  await write("index.html", '<script src="/_next/static/app.js"></script>');
  const result = verify();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^missing_required_assets=1$/m);
  assert.match(result.stdout, /^missing_next_asset_references=2$/m);
  assert.match(result.stdout, /^missing_digital_twin_endpoint=1$/m);
  assert.match(result.stdout, /^missing_digital_twin_launcher=1$/m);
  assert.match(result.stdout, /^missing_public_contact=2$/m);
});

test("a disabled portfolio export passes even when shared CSS still contains chat styles", async (t) => {
  const { verify } = await fixture(t, false);
  const result = verify();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^digital_twin_expected=disabled$/m);
  assert.match(result.stdout, /^unexpected_digital_twin_content=0$/m);
});

test("a disabled export rejects leftover launcher markup, hydration payloads, and orphan client scripts", async (t) => {
  const { cwd, write, verify } = await fixture(t, false);
  const html = await readFile(join(cwd, "out", "index.html"), "utf8");
  await write("index.html", `${html}<button class="twin-launcher">Digital Twin</button>`);
  await write("index.txt", '"className":"twin-panel"');
  await write("_next/static/orphan.js", 'fetch("/v2/chat");');
  await write("fallback.js", 'const url = "http://localhost:8787";');
  await write("challenge.js", 'fetch("https://challenges.cloudflare.com/turnstile/v0/api.js");');
  const result = verify();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^unexpected_digital_twin_content=5$/m);
});

test("an explicitly public export requires the production URL and public Turnstile key in the client", async (t) => {
  const { verify, write } = await fixture(t);
  const env = {
    NEXT_PUBLIC_DIGITAL_TWIN_ENABLED: "true",
    NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL: "https://digital-twin-production.jcquevedo84.workers.dev",
    NEXT_PUBLIC_DIGITAL_TWIN_TURNSTILE_SITE_KEY: "synthetic_public_site_key",
  };
  assert.equal(verify(env).status, 1);
  await write("_next/static/app.js", JSON.stringify([
    "/v2/chat", env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL,
    env.NEXT_PUBLIC_DIGITAL_TWIN_TURNSTILE_SITE_KEY, "https://challenges.cloudflare.com/turnstile/v0/api.js",
  ]));
  assert.equal(verify(env).status, 0);
  assert.equal(verify({ ...env, NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL: "https://untrusted.example" }).status, 1);
});

test("static verification rejects subpath assets, broken anchors, and missing portrait and contact markup", async (t) => {
  const { cwd, write, verify } = await fixture(t, false);
  const html = await readFile(join(cwd, "out", "index.html"), "utf8");
  await write("index.html", html
    .replace('href="/_next/static/app.css"', 'href="/repo/_next/static/app.css"')
    .replace('href="#main"', 'href="#missing"')
    .replace('src="/jcquevedo84-linkedin.jpg"', 'src="/repo/jcquevedo84-linkedin.jpg"')
    .replace(professionalContact.linkedinUrl, "https://example.invalid/"));
  const result = verify();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^missing_next_asset_references=2$/m);
  assert.match(result.stdout, /^broken_navigation_anchors=1$/m);
  assert.match(result.stdout, /^missing_portfolio_markup=1$/m);
  assert.match(result.stdout, /^missing_public_contact_links=1$/m);
});
