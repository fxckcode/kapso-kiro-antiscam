import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AntiScamBot — Detectá posibles estafas antes de caer",
  description:
    "Reenviá un mensaje sospechoso a AntiScamBot por WhatsApp y recibí un análisis rápido con recomendaciones prácticas.",
  keywords: [
    "estafas",
    "WhatsApp",
    "phishing",
    "seguridad",
    "IA",
    "antiscam",
    "fraude",
  ],
  authors: [{ name: "Equipo AntiScamBot" }],
  openGraph: {
    title: "AntiScamBot — Detectá posibles estafas antes de caer",
    description:
      "Reenviá un mensaje sospechoso a AntiScamBot por WhatsApp y recibí un análisis rápido con recomendaciones prácticas.",
    type: "website",
    locale: "es_AR",
    siteName: "AntiScamBot",
  },
  twitter: {
    card: "summary_large_image",
    title: "AntiScamBot — Detectá posibles estafas antes de caer",
    description:
      "Reenviá un mensaje sospechoso a AntiScamBot por WhatsApp y recibí un análisis rápido con recomendaciones prácticas.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#0a9264",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
