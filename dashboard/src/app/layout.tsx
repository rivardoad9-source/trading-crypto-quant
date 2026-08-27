import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowMetrix — Quant Command Center",
  description: "Meteora DLMM paper-trading engine and macro research dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-200 antialiased">{children}</body>
    </html>
  );
}
