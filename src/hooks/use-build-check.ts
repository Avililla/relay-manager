"use client"

import { useRef } from "react"
import { toast } from "sonner"
import { useServerEvents } from "@/components/providers/events-provider"
import { shell } from "@/lib/i18n/shell"

/**
 * `renderedBuildId` is ShellDTO.buildId from the server render. When an SSE `hello` reports another build
 * (the server was upgraded while this tab stayed open), a persistent toast offers "Recargar" (§8.8).
 */
export function useBuildCheck(renderedBuildId: string): void {
  const shown = useRef(false)
  useServerEvents(["hello"], (e) => {
    if (e.type !== "hello" || shown.current || !renderedBuildId || e.buildId === renderedBuildId) return
    shown.current = true
    toast.info(shell.newVersion, {
      id: "rm-new-version",
      description: shell.newVersionHint,
      duration: Infinity,
      dismissible: false,
      action: { label: shell.reload, onClick: () => window.location.reload() },
    })
  })
}
