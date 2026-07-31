import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  ),
  title: "FLUX 3 — BFL × Nous Research",
  description:
    "A live text-to-video wall by Black Forest Labs and Nous Research.",
  openGraph: {
    title: "FLUX 3 — BFL × Nous Research",
    description:
      "A live text-to-video wall by Black Forest Labs and Nous Research.",
  },
  twitter: {
    card: "summary_large_image",
    title: "FLUX 3 — BFL × Nous Research",
    description:
      "A live text-to-video wall by Black Forest Labs and Nous Research.",
  },
};

export const viewport: Viewport = {
  themeColor: "#050608",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
