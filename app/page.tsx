import { Navigation } from "@/components/Navigation";
import { Reveal } from "@/components/Reveal";
import { ContactOptions } from "@/components/ContactOptions";
import { ProfessionalPortrait } from "@/components/ProfessionalPortrait";
import { professionalContact } from "@/lib/contact";
import { earlierExperience, featuredExperience } from "@/lib/professional-experience";

const technicalSnapshot = [
  {
    label: "Core backend",
    title: "Java & Spring Boot",
    text: "Backend services, business workflows, APIs, and production troubleshooting.",
  },
  {
    label: "Architecture",
    title: "Distributed systems",
    text: "Microservices, asynchronous integration, service boundaries, and pragmatic trade-offs.",
  },
  {
    label: "Cloud & data",
    title: "AWS & PostgreSQL",
    text: "ECS, S3, SQS/SNS, Cognito, Parameter Store, Docker, and relational data platforms.",
  },
  {
    label: "Payments",
    title: "Payment integrations",
    text: "ACH processing, RTP and FedNow flows, plus ISO 20022 financial messaging.",
  },
];

const expertise = [
  {
    number: "01",
    title: "Payment systems",
    text: "Backend components for RTP, FedNow, and ACH flows — including message transformation, file processing, integration APIs, and simulators for validating settlement scenarios.",
    tags: ["RTP", "FedNow", "ACH", "ISO 20022"],
  },
  {
    number: "02",
    title: "Architecture in practice",
    text: "System design that stays grounded in delivery: clear service boundaries, maintainable data models, pragmatic trade-offs, and architecture decisions made close to the code.",
    tags: ["System design", "Clean architecture", "OpenAPI", "jOOQ"],
  },
  {
    number: "03",
    title: "Distributed backends",
    text: "Production APIs and asynchronous workflows for integration-heavy products, with hands-on experience across Java services, GraphQL, event-driven messaging, and third-party platforms.",
    tags: ["REST", "GraphQL", "SQS / SNS", "Microservices"],
  },
  {
    number: "04",
    title: "Reliable delivery",
    text: "Performance investigation, automated testing, production troubleshooting, and security-focused library maintenance across remote, cross-functional engineering teams.",
    tags: ["Testing", "Observability", "CI / CD", "Production support"],
  },
];

const stack = [
  ["Core engineering", "Java · Spring Boot · Node.js · Groovy · Go"],
  ["Data", "PostgreSQL · Oracle · MySQL · PL/SQL · jOOQ"],
  ["Cloud & delivery", "AWS ECS · S3 · SQS/SNS · Cognito · Docker · Jenkins"],
  ["Interfaces", "REST · GraphQL · OpenAPI · Event-driven systems · SOAP"],
  ["Quality", "Spock · Katalon · JMeter · Elastic Stack · CI/CD"],
];

const formalEducation = [
  {
    dates: "2000 — 2005",
    qualification: "Systems Engineering Degree",
    originalQualification: "Ingeniería de Sistemas",
    institution: "Universidad Nacional Experimental Politécnica de la Fuerza Armada (UNEFA)",
    detail: "Conservative English description · Original qualification shown above",
  },
  {
    dates: "2009 — 2012",
    qualification: "Master’s Degree in Systems Engineering",
    originalQualification: "Maestría en Ingeniería de Sistemas",
    institution: "Universidad Simón Bolívar",
    detail: "Completed · Conservative English description, not a certified translation",
  },
];

const professionalDevelopment = [
  "Curso de Introducción al Despliegue de Aplicaciones",
  "Curso Profesional de Git y GitHub",
  "Curso de Administración de Servidores Linux",
  "GitHub Copilot Masterclass for Java, Spring, AI and IntelliJ",
];

const currentLearning = [
  {
    provider: "CodeCrypto Academy",
    course: "Blockchain and Web3 training",
  },
  {
    provider: "AI Coder",
    course: "Complete Claude Code & Coding Agents Course",
  },
];

export default async function Home() {
  const DigitalTwin = process.env.NEXT_PUBLIC_DIGITAL_TWIN_ENABLED === "false"
    ? null
    : (await import("@/components/DigitalTwin")).DigitalTwin;

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: "Juan Carlos Rodríguez Quevedo",
    jobTitle: ["Senior Backend Engineer", "Software Architect", "Hands-on Tech Lead"],
    address: { "@type": "PostalAddress", addressLocality: "Buenos Aires", addressCountry: "AR" },
    email: professionalContact.email,
    telephone: professionalContact.phoneDisplay,
    sameAs: [professionalContact.linkedinUrl],
  };

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <Navigation />
      <main id="main">
        <section className="hero" id="top">
          <div className="hero-grid" aria-hidden="true" />
          <div className="hero-orbit" aria-hidden="true">
            <span className="orbit-ring orbit-ring-one" />
            <span className="orbit-ring orbit-ring-two" />
            <span className="orbit-core"><i /></span>
            <span className="orbit-node node-one" />
            <span className="orbit-node node-two" />
            <span className="orbit-node node-three" />
          </div>

          <div className="container hero-inner">
            <p className="eyebrow hero-eyebrow"><span /> Senior Backend Engineer · Software Architect · Hands-on Tech Lead</p>
            <h1>
              I design the architecture.<br />
              I write the code.<br />
              I build <em>reliable systems.</em>
            </h1>
            <p className="hero-copy">
              With 20+ years in software engineering, I design and build Java and Spring Boot backends, distributed systems, and payment platforms. I lead technical decisions while staying hands-on through implementation, testing, and production delivery.
            </p>
            <p className="hero-opportunity">Available for remote engineering opportunities and conversations about complex backend systems.</p>
            <p className="hero-location">Based in Buenos Aires, Argentina · Open to Remote Opportunities</p>
            <div className="hero-actions">
              <a className="button button-primary" href="#contact">Let&apos;s Talk <span aria-hidden="true">↓</span></a>
              <a className="button button-ghost" href="#experience">View Experience <span aria-hidden="true">↓</span></a>
            </div>

            <div className="hero-terminal" aria-label="Current professional focus">
              <div className="terminal-bar"><span /><span /><span /><b>ENGINEERING PROFILE</b></div>
              <div className="terminal-body">
                <p><span className="terminal-prompt">$</span> focus --current</p>
                <p className="terminal-result">payment architecture · backend reliability · AI-assisted engineering</p>
                <p><span className="terminal-prompt">$</span> stack --core</p>
                <p className="terminal-result">Java / Spring Boot / AWS / PostgreSQL</p>
              </div>
            </div>
          </div>

          <div className="container hero-metrics">
            <div><strong>20+</strong><span>Years in technology</span></div>
            <div><strong>Java + Spring</strong><span>Core backend stack</span></div>
            <div><strong>B2+</strong><span>Professional English</span></div>
            <div><strong>Hands-on</strong><span>Architecture style</span></div>
          </div>
        </section>

        <section className="technical-snapshot" aria-labelledby="technical-snapshot-title">
          <div className="container snapshot-inner">
            <Reveal className="snapshot-heading">
              <p className="eyebrow light"><span /> Technical Snapshot</p>
              <h2 id="technical-snapshot-title">Core expertise at a glance.</h2>
            </Reveal>
            <div className="snapshot-grid">
              {technicalSnapshot.map((item, index) => (
                <Reveal className="snapshot-card" key={item.label} delay={index * 55}>
                  <span>0{index + 1} / {item.label}</span>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className="section about-section" id="about">
          <div className="container section-grid">
            <Reveal className="section-intro">
              <p className="eyebrow dark"><span /> 01 / About</p>
              <h2>Architecture that<br />stays close to <em>reality.</em></h2>
              <div className="about-portrait-wrap">
                <ProfessionalPortrait />
              </div>
            </Reveal>
            <Reveal className="about-copy" delay={120}>
              <p className="lead">
                I&apos;m a senior software engineer and hands-on architect. My work starts with clear assumptions and business rules, then turns them into maintainable services that remain dependable in production.
              </p>
              <div className="copy-columns">
                <p>
                  My career spans fintech, sports technology, insurance, telecommunications, healthcare, and enterprise integration. Across those environments, the thread is consistent: complex workflows, consequential data, and systems that need to behave predictably.
                </p>
                <p>
                  I lead from architecture through implementation: reviewing design, mentoring engineers, troubleshooting production issues, and validating changes with relevant tests before delivery.
                </p>
              </div>
              <div className="location-line"><span>BA</span> Remote collaboration · Spanish & English</div>
            </Reveal>
          </div>
        </section>

        <section className="section expertise-section" id="expertise">
          <div className="container">
            <Reveal className="expertise-heading">
              <div>
                <p className="eyebrow light"><span /> 02 / Expertise</p>
                <h2>Built for complexity.<br /><em>Designed for change.</em></h2>
              </div>
              <p>Deep backend experience where domain rules, integrations, and operational reliability intersect.</p>
            </Reveal>

            <div className="expertise-list">
              {expertise.map((item, index) => (
                <Reveal key={item.number} className="expertise-row" delay={index * 60}>
                  <span className="expertise-number">{item.number}</span>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                  <div className="tag-list">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                </Reveal>
              ))}
            </div>

            <Reveal className="stack-panel">
              <div className="stack-label">
                <span className="pulse" /> TECHNICAL SYSTEM
              </div>
              <div className="stack-rows">
                {stack.map(([label, values]) => (
                  <div className="stack-row" key={label}>
                    <strong>{label}</strong><span>{values}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        <section className="section experience-section" id="experience">
          <div className="container">
            <Reveal className="experience-heading">
              <p className="eyebrow dark"><span /> 03 / Experience</p>
              <h2>From enterprise foundations<br />to <em>real-time systems.</em></h2>
              <p>Two decades of building, modernizing, and supporting software across industries and delivery models.</p>
            </Reveal>

            <div className="timeline timeline-featured">
              {featuredExperience.map((item, index) => (
                <Reveal className="timeline-item" key={item.company} delay={index * 70}>
                  <div className="timeline-date">{item.dates}</div>
                  <div className="timeline-marker"><span /></div>
                  <div className="timeline-content">
                    <div className="timeline-title"><h3>{item.company}</h3><p>{item.role}</p></div>
                    <p className="timeline-summary">{item.summary}</p>
                    <p className="timeline-tech">{item.tech}</p>
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal className="foundations-block">
              <details>
                <summary>
                  <span>
                    <b>Earlier Career — The Foundations</b>
                    <small>Explore My Earlier Career</small>
                    <span className="foundations-summary-copy">Discover the earlier roles and experiences that shaped my journey in software engineering, architecture, and technical leadership.</span>
                  </span>
                  <i aria-hidden="true">+</i>
                </summary>
                <div className="foundations-list">
                  {earlierExperience.map((item) => (
                    <div className="foundation-role" key={item.company}>
                      <span>{item.dates}</span>
                      <div><h3>{item.company}</h3><p>{item.role}</p></div>
                      <div><p>{item.summary}</p>{item.tech && <small>{item.tech}</small>}</div>
                    </div>
                  ))}
                </div>
              </details>
            </Reveal>
          </div>
        </section>

        <section className="section ai-section">
          <div className="container ai-grid">
            <Reveal className="ai-intro">
              <p className="eyebrow light"><span /> 04 / Working method</p>
              <h2>AI-assisted.<br /><em>Engineer-owned.</em></h2>
              <p>
                I use LLM-based tools to understand code, review specifications, explore alternatives, and prepare documentation. The architecture, validation, and decision to integrate remain mine.
              </p>
            </Reveal>
            <div className="process-list">
              {[
                ["01", "Frame", "Define the objective, constraints, and what must remain unchanged."],
                ["02", "Analyze", "Request a plan or focused analysis before modifying code."],
                ["03", "Inspect", "Review the diff against the requirement and challenge unnecessary complexity."],
                ["04", "Verify", "Run the relevant tests, examine edge cases, and decide what earns its way in."],
              ].map(([number, title, text], index) => (
                <Reveal className="process-step" key={number} delay={index * 70}>
                  <span>{number}</span><div><h3>{title}</h3><p>{text}</p></div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className="section portfolio-section" id="portfolio">
          <div className="container">
            <Reveal className="portfolio-heading">
              <div>
                <p className="eyebrow dark"><span /> 05 / Portfolio</p>
                <h2>Engineering<br /><em>Projects.</em></h2>
              </div>
              <p>Future projects will be presented only after they are reviewed, tested, and documented for professional use.</p>
            </Reveal>

            <Reveal className="portfolio-coming">
              <div className="portfolio-coming-mark" aria-hidden="true"><span /><i /></div>
              <div className="portfolio-coming-copy">
                <p className="portfolio-status"><span /> PORTFOLIO IN PREPARATION</p>
                <h3>Curated portfolio coming soon.</h3>
                <p>I&apos;m preparing a carefully selected collection of backend engineering projects demonstrating software architecture, distributed systems, and payment integrations.</p>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="section education-section" id="education">
          <div className="container">
            <Reveal className="education-heading">
              <div>
                <p className="eyebrow dark"><span /> 06 / Education</p>
                <h2>Education &<br /><em>Continuous Learning.</em></h2>
              </div>
              <p>Formal academic foundations, completed professional development, and current technical study.</p>
            </Reveal>

            <div className="learning-grid">
              <Reveal className="learning-column formal-learning">
                <div className="learning-column-title"><span>01</span><h3>Formal Education</h3></div>
                <div className="formal-list">
                  {formalEducation.map((item) => (
                    <div className="formal-item" key={item.qualification}>
                      <span>{item.dates}</span>
                      <h4>{item.qualification}</h4>
                      <em lang="es">{item.originalQualification}</em>
                      <p>{item.institution}</p>
                      <small>{item.detail}</small>
                    </div>
                  ))}
                </div>
                <p className="academic-note">English descriptions are provided for international readability. Original Spanish qualification names remain visible and are not presented as certified translations.</p>
              </Reveal>

              <Reveal className="learning-column" delay={80}>
                <div className="learning-column-title"><span>02</span><h3>Certifications & Professional Development</h3></div>
                <div className="credential-list">
                  {professionalDevelopment.map((credential) => (
                    <div key={credential}><p>{credential}</p><span>Completed</span></div>
                  ))}
                </div>
              </Reveal>

              <Reveal className="learning-column current-learning" delay={160}>
                <div className="learning-column-title"><span>03</span><h3>Current Learning</h3></div>
                <div className="current-learning-list">
                  {currentLearning.map((item) => (
                    <div key={item.course}>
                      <span>In progress</span><h4>{item.course}</h4><p>{item.provider}</p>
                    </div>
                  ))}
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="contact-section" id="contact">
          <div className="contact-grid" aria-hidden="true" />
          <div className="container contact-inner contact-layout">
            <Reveal className="contact-intro">
              <p className="eyebrow hero-eyebrow"><span /> 07 / Contact</p>
              <h2>Let&apos;s talk about<br /><em>reliable systems.</em></h2>
              <p>I&apos;m open to professional conversations about remote engineering roles, software architecture, complex backend systems, and carefully scoped software projects.</p>
            </Reveal>
            <Reveal className="contact-options-wrap" delay={100}>
              <ContactOptions />
            </Reveal>
          </div>
        </section>
      </main>

      <footer>
        <div className="container footer-inner">
          <div><span className="brand-mark" aria-hidden="true">JC</span><p>Juan Carlos Rodríguez Quevedo<br /><small>Senior Backend Engineer · Software Architect</small></p></div>
          <p>Buenos Aires, Argentina<br /><small>© {new Date().getFullYear()} · Built with intent.</small></p>
          <div className="footer-links">
            <a href="#top">Back to top <span aria-hidden="true">↑</span></a>
          </div>
        </div>
      </footer>

      {DigitalTwin && <DigitalTwin />}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
    </>
  );
}
