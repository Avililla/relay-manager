"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { RotateCwIcon } from "lucide-react"
import { Page } from "@/components/common/page"
import { Button } from "@/components/ui/button"
import { errorsText } from "@/lib/i18n/banco"
import { pages } from "@/lib/i18n/shell"

/** Banco error boundary (§8.9): what happened, the reference and "Reintentar". */
export default function BancoError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  return (
    <Page className="max-w-2xl py-10 md:py-14">
      <div role="alert" className="flex flex-col items-start gap-3">
        <h1 className="text-title text-foreground">{errorsText.bancoTitle}</h1>
        <p className="text-body text-muted-foreground">{errorsText.bancoBody}</p>
        {error.digest ? <p className="font-mono text-data text-muted-foreground">{pages.errorRef(error.digest)}</p> : null}
        <Button
          variant="primary"
          size="lg"
          disabled={pending}
          onClick={() => startTransition(() => {
            router.refresh()
            reset()
          })}
        >
          <RotateCwIcon aria-hidden />
          {pages.retry}
        </Button>
      </div>
    </Page>
  )
}
