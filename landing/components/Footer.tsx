import { Github, ShieldCheck } from "lucide-react";
import { GITHUB_REPO } from "@/lib/config";

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="container-page py-12">
        <div className="flex flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <div>
            <div className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              </span>
              AntiScamBot
            </div>
            <p className="mt-2 text-sm text-slate-600">
              AntiScamBot — Proyecto de hackathon
            </p>
            <p className="text-sm text-slate-500">
              Desarrollado por [Nombre Equipo]
            </p>
          </div>

          <nav
            className="flex flex-wrap items-center gap-x-6 gap-y-2"
            aria-label="Enlaces del pie de página"
          >
            <a
              href="#privacidad"
              className="text-sm font-medium text-slate-600 transition hover:text-brand-700"
            >
              Privacidad
            </a>
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 transition hover:text-brand-700"
            >
              <Github className="h-4 w-4" aria-hidden="true" />
              GitHub
            </a>
          </nav>
        </div>

        <div className="mt-8 border-t border-slate-100 pt-6">
          <p className="text-xs text-slate-500">
            Los veredictos son orientativos y no constituyen asesoramiento
            bancario, legal ni de seguridad.
          </p>
          <p className="mt-2 text-xs text-slate-400">
            © {year} AntiScamBot. Todos los derechos reservados.
          </p>
        </div>
      </div>
    </footer>
  );
}
