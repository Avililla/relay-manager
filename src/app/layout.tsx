import type { Metadata, Viewport } from "next"
import { ThemeAttrSync } from "@/components/providers/theme-attr-sync"
import { Toaster } from "@/components/ui/sonner"
import { browserCheckScript, htmlThemeAttrs, themeScript } from "@/lib/client/theme"
import { DEFAULT_LAB_NAME, PRODUCT_NAME } from "@/lib/i18n/common"
import { shell } from "@/lib/i18n/shell"
import { getViewerTheme } from "@/server/queries/viewer"
import { tryGetRuntime } from "@/server/runtime/registry"
import { monoFont, sansFont } from "./fonts"
import "./globals.css"

// Every route is dynamic (§2.2 rule 6): nothing is prerendered into the read-only app dir, and a lab-name change
// is never frozen into a static page.
export const dynamic = "force-dynamic"

export async function generateMetadata(): Promise<Metadata> {
  // Works without a runtime (next build): the defaults apply then.
  const labName = tryGetRuntime()?.settings.get().labName ?? DEFAULT_LAB_NAME
  return {
    // Pages set `title: "<Página>"` and get "<Página> · <labName>" (§8.1).
    title: { default: labName, template: `%s · ${labName}` },
    description: `${PRODUCT_NAME}: consolas serie y placas de relés del banco de integración`,
    applicationName: labName,
    robots: { index: false, follow: false },
    // Served from public/ (not an app/icon.svg metadata route, which `next build` would list as a static route).
    icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
  }
}

export const viewport: Viewport = {
  colorScheme: "dark light",
  width: "device-width",
  initialScale: 1,
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The signed-in viewer's theme is rendered on <html> (D39: saved in the account, no flash on any PC); signed out,
  // the inline script applies this browser's cached theme (the last user's).
  const theme = htmlThemeAttrs(await getViewerTheme())
  return (
    <html
      lang="es"
      data-theme={theme.theme}
      data-theme-user={theme.user}
      style={theme.colorScheme ? { colorScheme: theme.colorScheme } : undefined}
      suppressHydrationWarning
      className={`${sansFont.variable} ${monoFont.variable}`}
    >
      <head>
        {/* The theme is resolved before paint (account > cache > dark; "Sistema" by the OS), then the browser check. */}
        {/* eslint-disable-next-line react/no-danger -- static inline no-flash theme script (§2.2 rule 7, §8.2) */}
        <script dangerouslySetInnerHTML={{ __html: themeScript() + browserCheckScript() }} />
      </head>
      <body>
        <ThemeAttrSync account={theme.user ?? null} />
        <div id="rm-unsupported" role="alert">{shell.unsupportedBrowser}</div>
        {children}
        <Toaster />
      </body>
    </html>
  )
}
