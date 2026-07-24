import { MessageCircle, ShieldCheck, TriangleAlert, Sparkles } from "lucide-react";
import { buildWhatsAppLink } from "@/lib/config";

export default function Hero() {
  const waLink = buildWhatsAppLink();

  return (
    <section className="relative overflow-hidden">
      {/* Fondo decorativo */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
      >
        <div className="absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-brand-200/50 blur-3xl" />
        <div className="absolute right-0 top-32 h-64 w-64 rounded-full bg-trust-200/40 blur-3xl" />
      </div>

      <div className="container-page py-16 sm:py-20 lg:py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          {/* Columna de texto */}
          <div className="animate-fade-up text-center lg:text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-4 py-1.5 text-xs font-semibold text-brand-700 sm:text-sm">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Hackathon IA Masivo AWS x Código Facilito
            </span>

            <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">
              AntiScamBot
            </h1>

            <p className="mt-4 text-xl font-semibold text-brand-700 sm:text-2xl">
              Detectá posibles estafas antes de caer
            </p>

            <p className="mx-auto mt-4 max-w-xl text-base text-slate-600 sm:text-lg lg:mx-0">
              Reenviá un mensaje sospechoso, un link o una captura a nuestro bot
              de WhatsApp y recibí un análisis rápido con recomendaciones
              prácticas SFDGDF.
            </p>

            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary w-full sm:w-auto"
              >
                <MessageCircle className="h-5 w-5" aria-hidden="true" />
                Probar en WhatsApp
              </a>
              <a href="#como-funciona" className="btn-secondary w-full sm:w-auto">
                Ver cómo funciona
              </a>
            </div>

            {/* Fila de confianza */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm font-medium text-slate-600 lg:justify-start">
              <span className="inline-flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-brand-600" aria-hidden="true" />
                Análisis con IA
              </span>
              <span className="hidden text-slate-300 sm:inline" aria-hidden="true">
                |
              </span>
              <span className="inline-flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-trust-600" aria-hidden="true" />
                Veredicto rápido
              </span>
              <span className="hidden text-slate-300 sm:inline" aria-hidden="true">
                |
              </span>
              <span className="inline-flex items-center gap-2">
                <MessageCircle
                  className="h-4 w-4 text-brand-600"
                  aria-hidden="true"
                />
                Recomendaciones claras
              </span>
            </div>
          </div>

          {/* Ilustración conceptual (SVG/CSS): chat + escudo + alerta */}
          <div className="animate-fade-up flex justify-center lg:justify-end">
            <HeroIllustration />
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroIllustration() {
  return (
    <div className="relative w-full max-w-sm">
      {/* Tarjeta principal de chat */}
      <div className="animate-float rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-white">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-900">AntiScamBot</p>
            <p className="text-xs text-brand-600">en línea</p>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {/* Mensaje del usuario */}
          <div className="ml-auto max-w-[80%] rounded-2xl rounded-tr-sm bg-slate-100 px-4 py-2 text-sm text-slate-700">
            &quot;Ganaste un premio 🎉 Ingresá tus datos acá: bit.ly/premio…&quot;
          </div>

          {/* Respuesta del bot */}
          <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-alert-200 bg-alert-50 px-4 py-3 text-sm text-slate-800">
            <span className="flex items-center gap-2 font-semibold text-alert-600">
              <TriangleAlert className="h-4 w-4" aria-hidden="true" />
              Riesgo alto
            </span>
            <p className="mt-1 text-slate-600">
              Parece una estafa. No ingreses tus datos ni hagas clic en el link.
            </p>
          </div>
        </div>
      </div>

      {/* Insignia de escudo flotante */}
      <div className="absolute -bottom-4 -left-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-trust-600 text-white shadow-lg">
        <ShieldCheck className="h-8 w-8" aria-hidden="true" />
      </div>
    </div>
  );
}
