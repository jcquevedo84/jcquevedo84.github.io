import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = "out";
const forbiddenText = [
  "Profile.pdf",
  "Contenido_para_mi_sitio_profesional",
  "Trayectoria_profesional_antes_de_e4GS_Lab",
  "OPENROUTER_API_KEY",
  "sk-or-",
  "BORRADOR EDITORIAL PRIVADO",
  "Fuentes privadas de revisión",
  "Notifications of Change",
  "SEC codes",
];
const forbiddenExtensions = [".docx", ".pdf"];
const requiredPublicContact = ["jcquevedo84@gmail.com", "+54 9 11 3275 2039"];

async function collectFiles(directory) {
  const files = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const metadata = await stat(path);
    if (metadata.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }
  return files;
}

async function configuredOpenRouterKey() {
  try {
    const environmentFile = await readFile(".env", "utf8");
    const assignment = environmentFile
      .split(/\r?\n/)
      .find((line) => /^\s*OPENROUTER_API_KEY\s*=/.test(line));
    if (!assignment) return "";
    return assignment
      .slice(assignment.indexOf("=") + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  } catch {
    return "";
  }
}

const files = await collectFiles(outputDirectory);
const disallowedFiles = files.filter((file) => forbiddenExtensions.some((extension) => file.endsWith(extension)));
let forbiddenMatches = 0;
let credentialMatches = 0;
const publicContactMatches = new Set();
const apiKey = await configuredOpenRouterKey();

for (const file of files) {
  const content = await readFile(file);
  const text = content.toString("utf8");
  if (forbiddenText.some((value) => text.includes(value))) forbiddenMatches += 1;
  if (apiKey && content.includes(Buffer.from(apiKey))) credentialMatches += 1;
  for (const value of requiredPublicContact) {
    if (text.includes(value)) publicContactMatches.add(value);
  }
}

const missingPublicContact = requiredPublicContact.length - publicContactMatches.size;
const failures = disallowedFiles.length + forbiddenMatches + credentialMatches + missingPublicContact;
console.log(`static_files_checked=${files.length}`);
console.log(`private_document_files=${disallowedFiles.length}`);
console.log(`forbidden_content_matches=${forbiddenMatches}`);
console.log(`credential_configured=${Boolean(apiKey)}`);
console.log(`credential_matches=${credentialMatches}`);
console.log(`required_public_contact_matches=${publicContactMatches.size}`);
console.log(`missing_public_contact=${missingPublicContact}`);
console.log(`static_privacy_check=${failures === 0 ? "PASS" : "FAIL"}`);

if (failures > 0) process.exitCode = 1;
