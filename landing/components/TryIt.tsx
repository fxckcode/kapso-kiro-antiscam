import { MessageCircle, TriangleAlert } from "lucide-react";
import WhatsAppQR from "@/components/WhatsAppQR";
import {
  buildWhatsAppLink,
  WHATSAPP_DISPLAY,
  IS_PLACEHOLDER_NUMBER,
} from "@/lib/config";

const INSTRUCTIONS = [
  "Escaneá el QR con la cámara de tu celular.",
  "O agregá el número y escribinos por WhatsApp.",
  "Mandá el mensaje sospechoso y esperá el análisis.",
];

export default function TryIt() {
  const waLink = buildWhatsAppLink();

  return (
    <section
      id="probalo"
      className="scroll-mt-20 border-t border-slate-100 bg-white py-16 sm:py-20"
    >
      <div className="container-page">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="section-title">Probalo ahora</h2>
          <p className="section-subtitle">
            Escaneá el QR o agregá el número desde WhatsApp
          </p>
        </div>

        <div className="mx-auto mt-12 grid max-w-4xl items-center gap-10 md:grid-cols-2">
          {/* QR */}
          <div className="flex flex-col items-center gap-4">
            <WhatsAppQR />
            <div className="text-center">
              <p className="text-sm text-slate-500">Número de AntiScamBot</p>
              <p className="text-lg font-semibold text-slate-900">
                {WHATSAPP_DISPLAY}
              </p>
            </div>
            <a
              href={waLink}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary w-full sm:w-auto"
              aria-disabled={IS_PLACEHOLDER_NUMBER}
            >
              <MessageCircle className="h-5 w-5" aria-hidden="true" />
              Abrir WhatsApp
            </a>
          </div>

          {/* Instrucciones */}
          <div>
            <ol className="space-y-4">
              {INSTRUCTIONS.map((text, index) => (
                <li key={text} className="flex items-start gap-3">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
                    {index + 1}
                  </span>
                  <span className="pt-0.5 text-slate-700">{text}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {/* Disclaimer obligatorio */}
        <div
          role="note"
          className="mx-auto mt-12 flex max-w-3xl items-start gap-3 rounded-2xl border border-alert-200 bg-alert-50 p-5 text-sm text-slate-700"
        >
          <TriangleAlert
            className="mt-0.5 h-5 w-5 flex-shrink-0 text-alert-600"
            aria-hidden="true"
          />
          <p>
            <span className="font-semibold text-alert-600">Atención:</span>{" "}
            AntiScamBot es un MVP temporal creado para un hackathon. Los
            veredictos son orientativos y pueden fallar. No compartas claves,
            tarjetas, CBU, CVV ni códigos de verificación.
          </p>
        </div>
      </div>
    </section>
  );
}
