"use client";

import { useEffect, useState } from "react";

const links = [
  { href: "#about", label: "About" },
  { href: "#expertise", label: "Expertise" },
  { href: "#experience", label: "Experience" },
  { href: "#education", label: "Education" },
  { href: "#portfolio", label: "Portfolio" },
];

export function Navigation() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`site-header${scrolled ? " is-scrolled" : ""}`}>
      <a className="brand" href="#top" aria-label="Juan Carlos Rodríguez Quevedo, home">
        <span className="brand-mark" aria-hidden="true">JC</span>
        <span className="brand-name">RODRÍGUEZ<br />QUEVEDO</span>
      </a>

      <button
        className="menu-button"
        type="button"
        aria-expanded={open}
        aria-controls="primary-navigation"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sr-only">Toggle navigation</span>
        <span /><span />
      </button>

      <nav id="primary-navigation" className={open ? "nav-open" : ""} aria-label="Primary navigation">
        {links.map((link) => (
          <a key={link.href} href={link.href} onClick={() => setOpen(false)}>
            {link.label}
          </a>
        ))}
        <a
          className="nav-cta"
          href="#contact"
          onClick={() => setOpen(false)}
        >
          Contact <span aria-hidden="true">↓</span>
        </a>
      </nav>
    </header>
  );
}
