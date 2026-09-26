import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Soft Mania AWS Labs",
  description: "Soft Mania AWS Labs Portal",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
