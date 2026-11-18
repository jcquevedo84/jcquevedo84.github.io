import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { professionalContact } from "../lib/contact.ts";
import {
  earlierExperience,
  featuredExperience,
  featuredOrganizations,
  professionalExperience,
} from "../lib/professional-experience.ts";

const pageSource = await readFile("app/page.tsx", "utf8");
const navigationSource = await readFile("components/Navigation.tsx", "utf8");
const nextConfigSource = await readFile("next.config.ts", "utf8");

test("professional contact links use the approved public details and encoded copy", () => {
  const whatsapp = new URL(professionalContact.whatsappUrl);
  assert.equal(whatsapp.origin, "https://wa.me");
  assert.equal(whatsapp.pathname, "/5491132752039");
  assert.equal(
    whatsapp.searchParams.get("text"),
    "Hi Juan Carlos, I found your professional portfolio and would like to discuss a potential backend engineering opportunity or software project. Are you available to connect?",
  );

  const expectedSubject = "Backend Engineering Opportunity — Juan Carlos Rodríguez Quevedo";
  const expectedBody = `Hello Juan Carlos,

I came across your professional portfolio and would like to connect regarding a potential backend engineering opportunity or software project.

I would be happy to share more details.

Best regards,`;

  const gmail = new URL(professionalContact.gmailUrl);
  assert.equal(gmail.origin, "https://mail.google.com");
  assert.equal(gmail.pathname, "/mail/");
  assert.equal(gmail.searchParams.get("view"), "cm");
  assert.equal(gmail.searchParams.get("fs"), "1");
  assert.equal(gmail.searchParams.get("to"), "jcquevedo84@gmail.com");
  assert.equal(gmail.searchParams.get("su"), expectedSubject);
  assert.equal(gmail.searchParams.get("body"), expectedBody);

  const mailto = new URL(professionalContact.mailtoUrl);
  assert.equal(mailto.protocol, "mailto:");
  assert.equal(mailto.pathname, "jcquevedo84@gmail.com");
  assert.equal(mailto.searchParams.get("subject"), expectedSubject);
  assert.equal(mailto.searchParams.get("body"), expectedBody);
  assert.equal(professionalContact.phoneDisplay, "+54 9 11 3275 2039");
});

test("navigation and hero direct professional conversations to the contact area", () => {
  assert.match(navigationSource, /className="nav-cta"[\s\S]*href="#contact"/);
  assert.match(pageSource, /href="#contact">Let&apos;s Talk/);
  assert.doesNotMatch(navigationSource, /linkedin\.com/i);
});

test("portfolio is intentionally coming soon without public repository promotion", () => {
  assert.match(pageSource, /Curated portfolio coming soon\./);
  assert.doesNotMatch(pageSource, /github\.com\/jcquevedo84/i);
  assert.doesNotMatch(pageSource, /reserved project|project slot/i);
});

test("approved positioning and conservative academic wording remain present", () => {
  assert.match(pageSource, /I design the architecture\./);
  assert.match(pageSource, /I write the code\./);
  assert.match(pageSource, /I build <em>reliable systems\.<\/em>/);
  assert.match(pageSource, /Systems Engineering Degree/);
  assert.match(pageSource, /Master’s Degree in Systems Engineering/);
  assert.match(pageSource, /not a certified translation/);
  assert.doesNotMatch(pageSource, /Bachelor of Science|Master of Science/);
});

test("misleading rail metric is removed and verified payment terminology remains", () => {
  assert.doesNotMatch(pageSource, /3 Modern Payment Rails/i);
  assert.match(pageSource, /ACH processing, RTP and FedNow flows, plus ISO 20022 financial messaging/);
});

test("static export remains enabled while the official development indicator is disabled", () => {
  assert.match(nextConfigSource, /output:\s*["']export["']/);
  assert.match(nextConfigSource, /devIndicators:\s*false/);
});

test("experience classification preserves complete coverage without duplication", () => {
  const expectedEarlierOrganizations = [
    "Acciona IT",
    "Epidata",
    "Capgemini",
    "Corporacion Venseg 18",
    "E4GS Lab",
    "TotalTexto / SMPP Telecom",
    "Corporación Consultec",
    "Sanitas de Venezuela",
    "UNEFA Caracas",
    "Ministry of Interior and Justice",
    "La Electricidad de Caracas",
    "VACORP",
  ];

  assert.deepEqual(featuredExperience.map(({ company }) => company), [...featuredOrganizations]);
  assert.deepEqual(earlierExperience.map(({ company }) => company), expectedEarlierOrganizations);
  assert.equal(professionalExperience.length, 15);
  assert.equal(featuredExperience.length, 3);
  assert.equal(earlierExperience.length, 12);

  const classifiedCompanies = [...featuredExperience, ...earlierExperience].map(({ company }) => company);
  assert.equal(new Set(classifiedCompanies).size, professionalExperience.length);
  assert.deepEqual(
    new Set(classifiedCompanies),
    new Set(professionalExperience.map(({ company }) => company)),
  );
  assert.ok(professionalExperience.every(({ dates, role, summary }) => dates && role && summary));
});

test("earlier career remains a collapsed accessible disclosure with the approved label", () => {
  assert.match(pageSource, /<details>/);
  assert.doesNotMatch(pageSource, /<details\s+open/);
  assert.match(pageSource, /Explore My Earlier Career/);
  assert.match(pageSource, /Discover the earlier roles and experiences that shaped my journey/);
  assert.doesNotMatch(pageSource, /ARCHITECTURE &amp; CONSULTING|ARCHITECTURE & CONSULTING/);
});
