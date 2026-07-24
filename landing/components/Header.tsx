"use client";

import { useState } from "react";
import { Menu, X, ShieldCheck } from "lucide-react";
import { buildWhatsAppLink } from "@/lib/config";

const NAV_LINKS = [
  { href: "#como-funciona", label: "Cómo funciona" },
  { href: "#probalo", label: "Probalo" },
  { href: "#privacidad", label: "Privacidad" },
];

export default function Header() {
  const [open, setOpen] = useState(false);
  const waLink = buildWhatsAppLink();

  return (
    <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/85 backdrop-blur">
      <div className="container-page flex h-16 items-center justify-between">
        <a
          href="#"
          className="flex items-center gap-2 text-lg font-bold text-slate-900"
          aria-label="AntiScamBot, ir al inicio"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <span>
            Anti<span className="text-brand-600">Scam</span>Bot
          </span>
        </a>

        {/* Navegación desktop */}
        <nav
          className="hidden items-center gap-8 md:flex"
          aria-label="Navegación principal"
        >
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-slate-600 transition hover:text-brand-700"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden md:block">
          <a
            href={waLink}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary"
          >
            Probar ahora
          </a>
        </div>

        {/* Botón menú mobile */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 md:hidden"
          aria-label={open ? "Cerrar menú" : "Abrir menú"}
          aria-expanded={open}
          aria-controls="mobile-menu"
        >
          {open ? (
            <X className="h-6 w-6" aria-hidden="true" />
          ) : (
            <Menu className="h-6 w-6" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Menú mobile */}
      {open && (
        <div
          id="mobile-menu"
          className="border-t border-slate-200 bg-white md:hidden"
        >
          <nav
            className="container-page flex flex-col gap-1 py-4"
            aria-label="Navegación mobile"
          >
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-3 text-base font-medium text-slate-700 transition hover:bg-slate-100"
              >
                {link.label}
              </a>
            ))}
            <a
              href={waLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="btn-primary mt-2"
            >
              Probar ahora
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
