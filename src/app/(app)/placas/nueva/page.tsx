import type { Metadata } from "next"
import { BoardForm, type BoardFormProps } from "@/components/boards/board-form"
import { connectionKey, draftFromDiscovered, emptyDraft } from "@/components/boards/board-form-model"
import { discoveredAddress, discoveredModel } from "@/components/discovery/relay-model"
import { hardwarePages } from "@/lib/i18n/hardware"
import { getDiscoveredBoard } from "@/server/queries/relay-discovery"
import { getRuntime } from "@/server/runtime/registry"
import { keptSearch, requireAdminPage } from "../_lib/require-admin-page"

export const metadata: Metadata = { title: hardwarePages.newBoard }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/**
 * Nueva placa (§8.9, admin). `?desde=<discoveredKey>` prefills the form from a discovery result; an unknown key
 * (for example after a server restart) opens the empty form with the "ya no está disponible" alert.
 */
export default async function NuevaPlacaPage({ searchParams }: Props) {
  const sp = await searchParams
  await requireAdminPage(`/placas/nueva${keptSearch(sp, ["desde"])}`)
  const raw = sp.desde
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim() || null
  const found = key ? await getDiscoveredBoard(key) : null
  let discovery: BoardFormProps["discovery"] = null
  let initial = emptyDraft()
  if (found) {
    initial = draftFromDiscovered(found)
    discovery = {
      status: "found",
      label: [discoveredModel(found), discoveredAddress(found)].filter(Boolean).join(" · "),
      test: found.detect ? { key: connectionKey(initial), results: [found.detect], fromDiscovery: true } : null,
    }
  } else if (key) {
    discovery = { status: "missing" }
  }
  return <BoardForm mode="create" initial={initial} discovery={discovery} simulatedAllowed={getRuntime().relays.simulatedAllowed()} />
}
