import { Inter } from "next/font/google";

import { THEME_SCRIPT } from "@/lib/theme/themeScript";

import { AppProviders } from "./providers";
import "./globals.css";

// The app sets headings and body in Inter; 700 is for its bold headings.
const inter = Inter({ subsets: ["latin"], display: "swap", weight: ["400", "500", "600", "700"], variable: "--font-inter" });

export const metadata = {
  title: {
    default: "Orbik",
    template: "%s | Orbik",
  },
  description: "Your website as a knowledge base and brand your own AI can read.",
};

/** Root HTML document and shared client-provider boundary. */
export default function RootLayout({ children }) {
  return (
    // data-theme is replaced before first paint by THEME_SCRIPT, so React must accept the DOM's value.
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`h-full antialiased ${inter.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full bg-background text-foreground">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
