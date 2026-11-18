const email = "jcquevedo84@gmail.com";
const whatsappNumber = "5491132752039";

const whatsappMessage =
  "Hi Juan Carlos, I found your professional portfolio and would like to discuss a potential backend engineering opportunity or software project. Are you available to connect?";

const emailSubject = "Backend Engineering Opportunity — Juan Carlos Rodríguez Quevedo";
const emailBody = `Hello Juan Carlos,

I came across your professional portfolio and would like to connect regarding a potential backend engineering opportunity or software project.

I would be happy to share more details.

Best regards,`;

const encodedEmail = encodeURIComponent(email);
const encodedEmailSubject = encodeURIComponent(emailSubject);
const encodedEmailBody = encodeURIComponent(emailBody);

export const professionalContact = Object.freeze({
  email,
  phoneDisplay: "+54 9 11 3275 2039",
  whatsappNumber,
  linkedinUrl: "https://www.linkedin.com/in/jcquevedo84/",
  whatsappUrl: `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(whatsappMessage)}`,
  gmailUrl: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodedEmail}&su=${encodedEmailSubject}&body=${encodedEmailBody}`,
  mailtoUrl: `mailto:${email}?subject=${encodedEmailSubject}&body=${encodedEmailBody}`,
});
