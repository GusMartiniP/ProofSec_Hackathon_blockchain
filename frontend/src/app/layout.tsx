import type { Metadata } from "next";
import { WalletContextProvider } from "@/components/WalletContextProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProofSec | Solana Programmable Security Escrow",
  description: "Autonomous Agentic Payments & Cryptographic Evidence Verification for Cybersecurity",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 min-h-screen">
        <WalletContextProvider>
          {children}
        </WalletContextProvider>
      </body>
    </html>
  );
}
