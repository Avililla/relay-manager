import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"
import { BrandMark } from "@/components/shell/brand-mark"
import { buttonVariants } from "@/components/ui/button"
import { pages } from "@/lib/i18n/shell"

export const metadata: Metadata = { title: pages.notFoundTitle }

/** Global 404 (outside the app shell, e.g. an unknown top-level URL). */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="flex w-full max-w-md flex-col items-start gap-4">
        <BrandMark />
        <p className="font-mono text-data text-faint-foreground">404</p>
        <h1 className="text-title text-foreground">{pages.notFoundTitle}</h1>
        <p className="text-body text-muted-foreground">{pages.notFoundBody}</p>
        <Link href="/" className={buttonVariants({ variant: "primary", size: "lg" })}>
          <ArrowLeftIcon aria-hidden />
          {pages.backToBanco}
        </Link>
      </div>
    </main>
  )
}
