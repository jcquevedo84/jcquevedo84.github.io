import { professionalContact } from "@/lib/contact";

const Arrow = () => <span aria-hidden="true">↗</span>;

const contactOptions = [
  {
    number: "02",
    label: "WhatsApp",
    value: professionalContact.phoneDisplay,
    action: "Contact via WhatsApp",
    href: professionalContact.whatsappUrl,
    description: "A direct option for a quick professional conversation.",
    external: true,
  },
  {
    number: "03",
    label: "LinkedIn",
    value: "linkedin.com/in/jcquevedo84",
    action: "View LinkedIn Profile",
    href: professionalContact.linkedinUrl,
    description: "Connect and review Juan Carlos’s professional network profile.",
    external: true,
  },
];

export function ContactOptions() {
  return (
    <div className="contact-options">
      <article className="contact-option contact-option-email" aria-labelledby="contact-email-label">
        <span className="contact-option-number">01</span>
        <div>
          <p className="contact-option-label" id="contact-email-label">Email</p>
          <strong>{professionalContact.email}</strong>
          <small>Open a prefilled Gmail message or use your preferred email application.</small>
        </div>
        <div className="contact-option-actions">
          <a
            className="contact-action contact-action-primary"
            href={professionalContact.gmailUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Compose in Gmail to ${professionalContact.email}`}
          >
            Compose in Gmail <Arrow />
          </a>
          <a
            className="contact-action"
            href={professionalContact.mailtoUrl}
            aria-label={`Use email app to contact ${professionalContact.email}`}
          >
            Use Email App <Arrow />
          </a>
        </div>
      </article>

      {contactOptions.map((option) => (
        <a
          className="contact-option"
          href={option.href}
          key={option.label}
          aria-label={`${option.action}: ${option.value}`}
          {...(option.external ? { target: "_blank", rel: "noreferrer" } : {})}
        >
          <span className="contact-option-number">{option.number}</span>
          <div>
            <p className="contact-option-label">{option.label}</p>
            <strong>{option.value}</strong>
            <small>{option.description}</small>
          </div>
          <b>{option.action} <Arrow /></b>
        </a>
      ))}
    </div>
  );
}
