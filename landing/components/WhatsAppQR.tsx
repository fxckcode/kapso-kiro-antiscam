"use client";

import { QRCodeSVG } from "qrcode.react";
import { QrCode } from "lucide-react";
import { buildWhatsAppLink, IS_PLACEHOLDER_NUMBER } from "@/lib/config";

export default function WhatsAppQR() {
  const link = buildWhatsAppLink();

  if (IS_PLACEHOLDER_NUMBER) {
    return (
      <div
        className="flex h-[232px] w-[232px] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center"
        role="img"
        aria-label="Código QR no disponible: el número de WhatsApp todavía no fue configurado"
      >
        <QrCode className="h-10 w-10 text-slate-400" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-500">
          El QR aparecerá cuando se configure el número de WhatsApp.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <QRCodeSVG
        value={link}
        size={200}
        level="M"
        marginSize={2}
        fgColor="#0b4c39"
        bgColor="#ffffff"
        role="img"
        aria-label="Código QR para abrir WhatsApp de AntiScamBot"
      />
    </div>
  );
}
