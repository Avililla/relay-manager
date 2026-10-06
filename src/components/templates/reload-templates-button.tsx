"use client"

import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RefreshCwIcon } from "lucide-react"
import { reloadTemplates } from "@/actions/templates"
import { Button } from "@/components/ui/button"
import { useAction } from "@/hooks/use-action"
import { templateText as t } from "@/lib/i18n/wizard"

/** «Recargar plantillas» (admin): copies the profile's template files into the database and reports what changed. */
export function ReloadTemplatesButton() {
  const router = useRouter()
  const reload = useAction(reloadTemplates)
  const run = async () => {
    const r = await reload.run({})
    if (!r.ok) return
    const d = r.data
    const changes = d.created.length + d.updated.length + d.linked.length + d.retired.length
    if (d.errors.length) toast.error(t.reloadErrors(d.errors.length))
    else if (changes) toast.success(t.reloadDone(changes))
    else toast.success(t.reloadNothing)
    router.refresh()
  }
  return (
    <Button variant="outline" size="lg" onClick={() => void run()} disabled={reload.pending}>
      <RefreshCwIcon aria-hidden className={reload.pending ? "animate-spin" : undefined} />{t.reload}
    </Button>
  )
}
