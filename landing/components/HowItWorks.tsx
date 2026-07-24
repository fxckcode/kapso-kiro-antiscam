import {
  MessageCircle,
  Bot,
  ShieldCheck,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";

const BLOCKS = [
  {
    icon: MessageCircle,
    title: "WhatsApp",
    text: "El usuario envía un mensaje, link o captura sospechosa.",
    color: "text-brand-600",
    bg: "bg-brand-50",
  },
  {
    icon: Bot,
    title: "Bot",
    text: "AntiScamBot recibe el contenido y aplica reglas rápidas.",
    color: "text-trust-600",
    bg: "bg-trust-50",
  },
  {
    icon: ShieldCheck,
    title: "Análisis",
    text: "Se evalúa con IA, reputación de links y patrones de estafas conocidas.",
    color: "text-alert-600",
    bg: "bg-alert-50",
  },
  {
    icon: CheckCircle2,
    title: "Respuesta",
    text: "Recibís un veredicto con nivel de riesgo y recomendaciones.",
    color: "text-brand-600",
    bg: "bg-brand-50",
  },
];

export default function HowItWorks() {
  return (
    <section
      id="como-funciona"
      className="scroll-mt-20 border-t border-slate-100 bg-slate-50 py-16 sm:py-20"
    >
      <div className="container-page">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="section-title">Qué hace el bot por dentro</h2>
          <p className="section-subtitle">Flujo simplificado del análisis</p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-stretch">
          {BLOCKS.map((block, index) => {
            const Icon = block.icon;
            const isLast = index === BLOCKS.length - 1;
            return (
              <div key={block.title} className="relative flex">
                <div className="card flex w-full flex-col items-center text-center">
                  <span
                    className={`flex h-14 w-14 items-center justify-center rounded-2xl ${block.bg} ${block.color}`}
                  >
                    <Icon className="h-7 w-7" aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-slate-900">
                    {block.title}
                  </h3>
                  <p className="mt-2 text-sm text-slate-600">{block.text}</p>
                </div>

                {/* Flecha conectora entre bloques */}
                {!isLast && (
                  <span
                    aria-hidden="true"
                    className="absolute left-1/2 top-full z-10 my-1 flex -translate-x-1/2 rotate-90 text-slate-300 lg:left-full lg:top-1/2 lg:my-0 lg:-translate-y-1/2 lg:translate-x-0 lg:rotate-0"
                  >
                    <ArrowRight className="h-6 w-6" />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
