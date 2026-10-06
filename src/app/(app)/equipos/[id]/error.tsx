"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowLeftIcon, RotateCwIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { Button } from "@/components/ui/button"
import { errorsText } from "@/lib/i18n/banco"
import { pages } from "@/lib/i18n/shell"

/** Error boundary of the workspace tabs (§8.9): the header stays; what happened, a reference and "Reintentar". */
export default function EquipoError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-3 px-4 py-10 md:px-6" role="alert">
      <h2 className="text-title text-foreground">{errorsText.workspaceTitle}</h2>
      <p className="text-body text-muted-foreground">{errorsText.workspaceBody}</p>
      {error.digest ? <p className="font-mono text-data text-muted-foreground">{pages.errorRef(error.digest)}</p> : null}
      <div className="flex flex-wrap gap-2">
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
        <Button size="lg" asChild>
          <AppLink href="/"><ArrowLeftIcon aria-hidden />{errorsText.backToBanco}</AppLink>
        </Button>
      </div>
    </div>
  )
}
