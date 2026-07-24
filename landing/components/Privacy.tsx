import {
  Database,
  Fingerprint,
  Clock,
  Lock,
  ShieldAlert,
  FlaskConical,
  Scale,
} from "lucide-react";

const CARDS = [
  {
    icon: Database,
    title: "Datos mínimos",
    text: "Procesamos el mensaje, link o imagen que envíes para analizar posibles estafas.",
  },
  {
    icon: Fingerprint,
    title: "No guardamos tu número en texto plano",
    text: "Usamos un identificador derivado del número para reconocer conversaciones.",
  },
  {
    icon: Clock,
    title: "Retención limitada",
    text: "El contenido se guarda temporalmente con fines de funcionamiento y mejora. En el MVP, la retención máxima es de 30 días.",
  },
  {
    icon: Lock,
    title: "Cifrado",
    text: "La información viaja por HTTPS y se almacena cifrada en reposo.",
  },
  {
    icon: ShieldAlert,
    title: "No envíes datos sensibles",
    text: "No compartas claves, tarjetas, CBU, CVV, códigos SMS, contraseñas ni información personal innecesaria.",
  },
  {
    icon: FlaskConical,
    title: "Proyecto experimental",
    text: "AntiScamBot es una herramienta de demostración. No reemplaza la verificación con bancos, empresas u organismos oficiales.",
  },
];

export default function Privacy() {
  return (
    <section
      id="privacidad"
      className="scroll-mt-20 border-t border-slate-100 bg-slate-50 py-16 sm:py-20"
    >
      <div className="container-page">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="section-title">Privacidad y datos</h2>
          <p className="section-subtitle">
            Qué hacemos con la información que enviás
          </p>
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <div key={card.title} className="card flex flex-col">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-trust-50 text-trust-600">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-slate-900">
                  {card.title}
                </h3>
                <p className="mt-2 text-sm text-slate-600">{card.text}</p>
              </div>
            );
          })}
        </div>

        {/* Bloque legal corto */}
        <div className="mx-auto mt-10 flex max-w-3xl items-start gap-3 rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          <Scale
            className="mt-0.5 h-5 w-5 flex-shrink-0 text-slate-400"
            aria-hidden="true"
          />
          <p>
            Al usar AntiScamBot entendés que es un proyecto experimental de
            hackathon y que los análisis son orientativos. Ante cualquier duda,
            verificá por canales oficiales.
          </p>
        </div>
      </div>
    </section>
  );
}
