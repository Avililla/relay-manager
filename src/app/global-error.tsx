"use client"

import * as React from "react"
import { RotateCwIcon } from "lucide-react"
import { BrandMark } from "@/components/shell/brand-mark"
import { buttonVariants } from "@/components/ui/button"
import { pages } from "@/lib/i18n/shell"
import { monoFont, sansFont } from "./fonts"
import "./globals.css"

/** Last-resort error page: replaces the root layout, so it renders its own <html> (dark, like the no-JS fallback). */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="es" data-theme="dark" className={`${sansFont.variable} ${monoFont.variable}`}>
      <body>
        <main className="grid min-h-dvh place-items-center px-4 py-10">
          <div role="alert" className="flex w-full max-w-md flex-col items-start gap-4">
            <BrandMark />
            <h1 className="text-title text-foreground">{pages.errorTitle}</h1>
            <p className="text-body text-muted-foreground">{pages.errorBody}</p>
            {error.digest ? <p className="font-mono text-data text-muted-foreground">{pages.errorRef(error.digest)}</p> : null}
            <button type="button" onClick={reset} className={buttonVariants({ variant: "primary", size: "lg" })}>
              <RotateCwIcon aria-hidden />
              {pages.retry}
            </button>
          </div>
        </main>
      </body>
    </html>
  )
}
