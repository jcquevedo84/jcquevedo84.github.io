import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = "out";
const digitalTwinEnabled = process.env.NEXT_PUBLIC_DIGITAL_TWIN_ENABLED !== "false";
const publicDigitalTwin = process.env.NEXT_PUBLIC_DIGITAL_TWIN_ENABLED === "true";
const productionApi = "https://digital-twin-production.jcquevedo84.workers.dev";
const configuredApi = process.env.NEXT_PUBLIC_DIGITAL_TWIN_API_BASE_URL;
const siteKey = process.env.NEXT_PUBLIC_DIGITAL_TWIN_TURNSTILE_SITE_KEY ?? "";
const forbiddenText = [
  "Profile.pdf",
  "Contenido_para_mi_sitio_profesional",
  "Trayectoria_profesional_antes_de_e4GS_Lab",
  "BORRADOR EDITORIAL PRIVADO",
  "Fuentes privadas de revisión",
  "Notifications of Change",
  "SEC codes",
];
const serverOnlyNames = ["OPENROUTER_API_KEY", "DIGITAL_TWIN_CONVERSATION_SIGNING_KEY", "TURNSTILE_SECRET_KEY"];
const credentialValues = serverOnlyNames
  .map((name) => process.env[name]?.trim())
  .filter(Boolean)
  .map((value) => Buffer.from(value));
const requiredPublicContact = ["jcquevedo84@gmail.com", "+54 9 11 3275 2039"];
const requiredContactLinks = [
  "mailto:jcquevedo84@gmail.com?",
  "https://mail.google.com/mail/?",
  "https://wa.me/5491132752039?",
  "https://www.linkedin.com/in/jcquevedo84/",
];
const requiredPublicAssets = ["index.html", "icon.svg", "jcquevedo84-linkedin.jpg"];
const requiredSectionIds = ["main", "top", "about", "expertise", "experience", "portfolio", "education", "contact"];
const requiredMarkup = [
  'src="/jcquevedo84-linkedin.jpg"',
  "Earlier Career — The Foundations",
  "<title>",
  'name="description"',
];
const privateDocument = /\.(?:docx?|pdf)$/i;
const digitalTwinMarkers = /\/(?:v1|v2)\/chat\b|:8787\b|\btwin-(?:launcher|panel)\b|challenges\.cloudflare\.com\/turnstile|digital-twin-production\.jcquevedo84\.workers\.dev/;

async function collectFiles(directory, prefix = "") {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = `${prefix}${entry.name}`;
    if (/(?:^|\/)(?:(?:\.env|\.dev\.vars)(?:\.|$)|(?:resource|server|backend|worker|node_modules|\.wrangler)(?:\/|$))/i.test(name)) {
      entries.push({ name, privatePath: true });
    } else if (entry.isDirectory()) {
      entries.push(...await collectFiles(path, `${name}/`));
    } else {
      entries.push({ path, name, regular: entry.isFile() });
    }
  }
  return entries;
}

async function verifyExport() {
  if (!(await lstat(outputDirectory)).isDirectory()) throw new Error("Invalid output directory");

  const entries = await collectFiles(outputDirectory);
  const publicContactFound = new Set();
  const publicFiles = new Set();
  const results = {
    static_files_checked: 0,
    private_document_files: 0,
    private_paths: 0,
    unsafe_entries: 0,
    forbidden_content_matches: 0,
    server_only_name_matches: 0,
    credential_pattern_matches: 0,
    credential_value_matches: 0,
    missing_required_assets: 0,
    missing_next_asset_references: 0,
    missing_portfolio_markup: 0,
    broken_navigation_anchors: 0,
    missing_digital_twin_endpoint: 0,
    missing_digital_twin_launcher: 0,
    invalid_public_digital_twin_config: Number(publicDigitalTwin
      && (configuredApi !== productionApi || !/^[A-Za-z0-9_-]{15,64}$/.test(siteKey))),
    missing_public_digital_twin_bindings: 0,
    unexpected_digital_twin_content: 0,
    missing_public_contact: 0,
    missing_public_contact_links: 0,
  };
  let indexHtml = "";
  let digitalTwinBundled = false;
  let publicDigitalTwinBundled = false;

  for (const { path, name, privatePath, regular } of entries) {
    if (privatePath) {
      results.private_paths += 1;
      continue;
    }
    if (privateDocument.test(name)) {
      results.private_document_files += 1;
      continue;
    }
    if (!regular || (await lstat(path)).nlink !== 1) {
      results.unsafe_entries += 1;
      continue;
    }

    const content = await readFile(path);
    const text = content.toString("utf8");
    const searchable = `${name}\n${text}`;
    results.static_files_checked += 1;
    if (content.length > 0) publicFiles.add(name);
    if (name === "index.html") indexHtml = text;
    if (name.startsWith("_next/static/") && name.endsWith(".js") && text.includes("/v2/chat")) {
      digitalTwinBundled = true;
      publicDigitalTwinBundled ||= Boolean(siteKey) && text.includes(productionApi) && text.includes(siteKey)
        && text.includes("challenges.cloudflare.com/turnstile");
    }
    if (!digitalTwinEnabled && /\.(?:js|mjs|html|txt)$/i.test(name) && digitalTwinMarkers.test(text)) {
      results.unexpected_digital_twin_content += 1;
    }
    if (forbiddenText.some((value) => searchable.includes(value))) results.forbidden_content_matches += 1;
    if (serverOnlyNames.some((value) => searchable.includes(value))) results.server_only_name_matches += 1;
    if (searchable.includes("sk-or-")) results.credential_pattern_matches += 1;
    if (credentialValues.some((value) => content.includes(value) || Buffer.from(name).includes(value))) {
      results.credential_value_matches += 1;
    }
    for (const value of requiredPublicContact) {
      if (text.includes(value)) publicContactFound.add(value);
    }
  }

  const assets = new Set(Array.from(
    indexHtml.matchAll(/\s(?:src|href)="([^"?#]*_next\/static\/[^"?#]+)(?:[?#][^"]*)?"/g),
    ([, path]) => path,
  ));
  const rootAssets = [...assets].filter((name) => name.startsWith("/_next/static/"));
  const sectionIds = new Set(Array.from(indexHtml.matchAll(/\sid="([^"]+)"/g), ([, id]) => id));
  const anchors = new Set(Array.from(indexHtml.matchAll(/\shref="#([^"]+)"/g), ([, id]) => id));
  results.missing_required_assets = requiredPublicAssets.filter((name) => !publicFiles.has(name)).length;
  results.missing_next_asset_references = [...assets].filter((name) => !rootAssets.includes(name) || !publicFiles.has(name.slice(1))).length
    + [".css", ".js"].filter((extension) => !rootAssets.some((name) => name.endsWith(extension))).length;
  results.missing_portfolio_markup = requiredSectionIds.filter((id) => !sectionIds.has(id)).length
    + requiredMarkup.filter((value) => !indexHtml.includes(value)).length;
  results.broken_navigation_anchors = [...anchors].filter((id) => !sectionIds.has(id)).length;
  results.missing_digital_twin_endpoint = Number(digitalTwinEnabled && !digitalTwinBundled);
  results.missing_digital_twin_launcher = Number(digitalTwinEnabled && !indexHtml.includes('class="twin-launcher"'));
  results.missing_public_digital_twin_bindings = Number(publicDigitalTwin && !publicDigitalTwinBundled);
  results.missing_public_contact = requiredPublicContact.length - publicContactFound.size;
  results.missing_public_contact_links = requiredContactLinks.filter((url) => !indexHtml.includes(`href="${url}`)).length;

  const passed = results.static_files_checked > 0
    && Object.entries(results).every(([name, count]) => name === "static_files_checked" || count === 0);
  for (const [name, count] of Object.entries(results)) console.log(`${name}=${count}`);
  console.log(`digital_twin_expected=${digitalTwinEnabled ? "enabled" : "disabled"}`);
  console.log(`credential_values_provided=${credentialValues.length}`);
  console.log(`static_privacy_check=${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
}

try {
  await verifyExport();
} catch {
  console.error("Static privacy verification could not read a valid out/ directory. Run the production build first.");
  console.log("static_privacy_check=FAIL");
  process.exitCode = 1;
}
