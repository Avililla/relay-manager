import * as React from "react"
import { BrandMark } from "@/components/shell/brand-mark"
import { auth as t } from "@/lib/i18n/admin"
import { cn } from "@/lib/client/cn"
import { PublicBanner } from "./public-banner"

/**
 * Frame of the public pages (§8.9 Login and Setup): optional banner strip, a centred column on --background,
 * the app mark with the lab name and the "Relay Manager" subtitle, then the page content and the version footer.
 * One `main` landmark; the lab name is the page's h1 unless `heading` provides one.
 */
export function AuthFrame({ labName, bannerText, version, rev, width = "narrow", heading, intro, children }: {
  labName: string
  bannerText: string | null
  version: string
  rev: string
  width?: "narrow" | "wide"
  /** Page heading below the brand block (Setup: "Configuración inicial"). Without it the lab name is the h1. */
  heading?: string
  intro?: React.ReactNode
  children: React.ReactNode
}) {
  const LabTag = heading ? "p" : "h1"
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <PublicBanner text={bannerText} />
      <main className={cn("mx-auto flex w-full flex-1 flex-col justify-center px-4 py-10", width === "narrow" ? "max-w-[392px]" : "max-w-[912px]")}>
        <div className={cn("flex flex-col gap-6", width === "narrow" && "sm:-mt-[6vh]")}>
          <div className="flex items-center gap-3">
            <BrandMark className="size-10" />
            <div className="flex min-w-0 flex-col">
              {/* With a page heading below, the lab name steps down so there is one title-size heading. */}
              <LabTag className={cn("truncate text-foreground", heading ? "text-section" : "text-title")}>{labName}</LabTag>
              <p className="text-meta text-muted-foreground">{t.subtitle}</p>
            </div>
          </div>
          {heading ? (
            <div className="flex flex-col gap-1">
              <h1 className="text-title text-foreground">{heading}</h1>
              {intro ? <p className="max-w-[64ch] text-body text-muted-foreground text-pretty">{intro}</p> : null}
            </div>
          ) : null}
          {children}
        </div>
      </main>
      <footer className="px-4 pb-5 text-center">
        <p className="font-mono text-meta text-faint-foreground tabular-nums">{t.footer(version, rev)}</p>
      </footer>
    </div>
  )
}
