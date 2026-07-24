import { Inbox, Forward, BadgeCheck } from "lucide-react";

const STEPS = [
  {
    icon: Inbox,
    title: "Recibiste un mensaje sospechoso",
    text: "Un premio raro, un link del banco, un familiar que pide plata urgente o una oferta demasiado buena.",
  },
  {
    icon: Forward,
    title: "Reenvialo al bot",
    text: "Abrí WhatsApp, mandá el mensaje, link o captura a AntiScamBot. No compartas claves, tarjetas ni códigos.",
  },
  {
    icon: BadgeCheck,
    title: "Obtené el veredicto",
    text: "El bot analiza el contenido y te responde si parece una estafa, con señales detectadas y recomendaciones.",
  },
];

export default function Steps() {
  return (
    <section className="border-t border-slate-100 bg-white py-16 sm:py-20">
      <div className="container-page">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="section-title">Cómo usarlo</h2>
          <p className="section-subtitle">Tres pasos simples</p>
        </div>

        <ol className="mt-12 grid gap-6 md:grid-cols-3">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            return (
              <li key={step.title} className="card relative flex flex-col">
                <span className="absolute -top-3 left-6 flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
                  {index + 1}
                </span>
                <span className="mt-2 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm text-slate-600">{step.text}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
