export type ProfessionalExperience = {
  dates: string;
  company: string;
  role: string;
  summary: string;
  tech?: string;
};

export const featuredOrganizations = [
  "Yabarana Corporation",
  "The Good Game Athletics",
  "OV Loop",
] as const;

const featuredOrganizationSet = new Set<string>(featuredOrganizations);

export const professionalExperience: ProfessionalExperience[] = [
  {
    dates: "2023 — PRESENT",
    company: "Yabarana Corporation",
    role: "Senior Backend Engineer / Payments Specialist",
    summary:
      "Engineering backend services for real-time settlement, clearing, and financial messaging platforms. Work spans RTP and FedNow transaction flows, ACH processing, payment simulation, and multibank integration support.",
    tech: "Java · Spring Boot · PostgreSQL · AWS · ISO 20022 · Docker",
  },
  {
    dates: "2024 — 2026",
    company: "The Good Game Athletics",
    role: "Senior Backend Engineer",
    summary:
      "Built and maintained backend services for a sports platform connecting athletes, coaches, and organizations. Delivered scheduling, memberships, booking logic, payments, notifications, and asynchronous workflows.",
    tech: "Java · Spring Boot · Node.js · GraphQL · PostgreSQL · AWS",
  },
  {
    dates: "2019 — 2024",
    company: "OV Loop",
    role: "Software Engineer / Backend Developer",
    summary:
      "Developed APIs and microservices for a distributed platform, working across identity, payments, chat, API automation, third-party integrations, and targeted maintenance of Go services.",
    tech: "Java · Spring Boot · Groovy · Node.js · Go · Microservices",
  },
  {
    dates: "2019",
    company: "Acciona IT",
    role: "Lead Software Architect",
    summary: "Architecture and hands-on development for a vehicle acquisition and savings-plan platform using Java and Oracle.",
  },
  {
    dates: "2018 — 2019",
    company: "Epidata",
    role: "Software IT Architect",
    summary: "Performance and regression testing, QA observability with Elastic Stack, and backend delivery for public-sector and healthcare systems.",
  },
  {
    dates: "2018",
    company: "Capgemini",
    role: "Senior Consultant / Solution Designer",
    summary: "Enterprise Java troubleshooting and integration design for automotive and banking environments.",
  },
  {
    dates: "2016 — 2018",
    company: "Corporacion Venseg 18",
    role: "Backend and Database Coordinator",
    summary: "Backend architecture, AWS development environments, database design, REST services, and technical team coordination.",
  },
  {
    dates: "2015 — 2016",
    company: "E4GS Lab",
    role: "Project Coordinator / Architect",
    summary: "Java and Spring Boot services for telecommunications, plus architecture, delivery coordination, and hands-on backend leadership.",
  },
  {
    dates: "AUG 2014 — MAY 2015",
    company: "TotalTexto / SMPP Telecom",
    role: "Development Engineer · Backend Technical Lead",
    summary: "Developed SOAP and REST telecommunications services, designed and maintained MySQL databases, wrote triggers and stored procedures, and supported GlassFish applications.",
    tech: "Java / J2EE · SOAP · REST · MySQL · GlassFish",
  },
  {
    dates: "AUG 2013 — AUG 2014",
    company: "Corporación Consultec",
    role: "Enterprise Applications Development Specialist",
    summary: "Contributed to banking and insurance integration projects through UML modeling, web services, stored procedures, notification workflows, and technical team support.",
    tech: "Java / J2EE · SOAP · Oracle · PL/SQL · UML",
  },
  {
    dates: "MAY 2011 — AUG 2013",
    company: "Sanitas de Venezuela",
    role: "Software Architect",
    summary: "Designed and developed healthcare integration services, including Java SOAP services and enterprise workflows using SOA, BPM, and Oracle middleware.",
    tech: "Java / J2EE · SOAP · Oracle Database · WebLogic · SOA / BPM",
  },
  {
    dates: "DOCUMENTED PERIODS · 2006 — 2008",
    company: "UNEFA Caracas",
    role: "Undergraduate Instructor",
    summary: "Taught programming languages, algorithms, object-oriented methodology, and data processing across documented, non-continuous teaching periods.",
    tech: "Programming · Algorithms · Object-oriented design · Data processing",
  },
  {
    dates: "JUL 2005 — MAY 2006",
    company: "Ministry of Interior and Justice",
    role: "Data Processing Analyst I",
    summary: "A documented early-career data-processing role. The available employment record verifies the position and dates but does not identify projects or technologies.",
    tech: "Role and dates verified · Technical scope not documented",
  },
  {
    dates: "SEP 2004 — MAR 2005",
    company: "La Electricidad de Caracas",
    role: "Systems Engineering Intern",
    summary: "Worked on a web application for estimating electrical-remodeling and public-lighting project costs. The available letter does not identify the technology stack.",
    tech: "Web application · Technology stack not documented",
  },
  {
    dates: "AUG — SEP 2004",
    company: "VACORP",
    role: "Industrial Intern",
    summary: "Completed a documented industrial internship while studying Systems Engineering. The available certificate does not describe responsibilities or technologies.",
    tech: "Internship period verified · Responsibilities not documented",
  },
];

export const featuredExperience = professionalExperience.filter(({ company }) =>
  featuredOrganizationSet.has(company),
);

export const earlierExperience = professionalExperience.filter(({ company }) =>
  !featuredOrganizationSet.has(company),
);
