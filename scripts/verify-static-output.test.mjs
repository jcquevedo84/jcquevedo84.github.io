import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { professionalContact } from "../lib/contact.ts";

const verifier = fileURLToPath(new URL("./verify-static-output.mjs", import.meta.url));
const openRouterMarker = "static-test-provider-canary";
const signingMarker = "static-test-signing-canary";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "portfolio-static-check-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  async function write(path, content) {
    const filename = join(cwd, "out", path);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }

  await write("index.html", `<p>${professionalContact.email} ${professionalContact.phoneDisplay}</p>
    <script src="/_next/static/app.js?v=1"></script>`);
  await write("icon.svg", "<svg/>");
  await write("jcquevedo84-linkedin.jpg", "image fixture");
  await write("_next/static/app.js", 'const endpoint = "/v2/chat";');

  function verify(env = {}) {
    const result = spawnSync(process.execPath, [verifier], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, OPENROUTER_API_KEY: "", DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: "", ...env },
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
  await write("names.txt", "OPENROUTER_API_KEY DIGITAL_TWIN_CONVERSATION_SIGNING_KEY");
  const namesOnly = verify();
  assert.equal(namesOnly.status, 1);
  assert.match(namesOnly.stdout, /^server_only_name_matches=1$/m);
  assert.match(namesOnly.stdout, /^credential_value_matches=0$/m);

  await write("provider.txt", openRouterMarker);
  await write("signing.txt", signingMarker);
  await write("pattern.txt", "sk-or-v1-synthetic-privacy-test");
  const secrets = verify({
    OPENROUTER_API_KEY: openRouterMarker,
    DIGITAL_TWIN_CONVERSATION_SIGNING_KEY: signingMarker,
  });
  assert.equal(secrets.status, 1);
  assert.match(secrets.stdout, /^credential_values_provided=2$/m);
  assert.match(secrets.stdout, /^credential_value_matches=2$/m);
  assert.match(secrets.stdout, /^credential_pattern_matches=1$/m);
  assert.doesNotMatch(secrets.stdout + secrets.stderr, /static-test-(?:provider|signing)-canary|sk-or-v1-synthetic-privacy-test/);
});

test("static verification rejects private paths, documents, and symlinks", async (t) => {
  const { cwd, write, verify } = await fixture(t);
  await write(".env.local", "fixture");
  await write("nested/resource/private.txt", "fixture");
  await write("nested/notes.PDF", "fixture");
  await write("nested/editorial.txt", "BORRADOR EDITORIAL PRIVADO");
  await symlink("icon.svg", join(cwd, "out", "link.svg"));
  const result = verify();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^private_paths=2$/m);
  assert.match(result.stdout, /^private_document_files=1$/m);
  assert.match(result.stdout, /^unsafe_entries=1$/m);
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
  assert.match(result.stdout, /^missing_next_asset_references=1$/m);
  assert.match(result.stdout, /^missing_digital_twin_endpoint=1$/m);
  assert.match(result.stdout, /^missing_public_contact=2$/m);
});
