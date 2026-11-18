import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Juan Carlos Rodríguez Quevedo | Backend Engineer & Software Architect",
  description:
    "Senior Backend Engineer, Software Architect, and hands-on Tech Lead with 20+ years of experience in Java, Spring Boot, distributed systems, and payment platforms.",
  keywords: [
    "Senior Backend Engineer",
    "Software Architect",
    "Hands-on Tech Lead",
    "Java",
    "Spring Boot",
    "AWS",
    "Payments",
    "FedNow",
    "RTP",
    "ACH",
  ],
  authors: [{ name: "Juan Carlos Rodríguez Quevedo" }],
  openGraph: {
    title: "Juan Carlos Rodríguez Quevedo | Backend Engineering",
    description:
      "Hands-on architecture and backend engineering for systems where reliability matters.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
