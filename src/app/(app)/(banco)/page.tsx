import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { BancoView } from "@/components/equipment/banco-view"
import { banco } from "@/lib/i18n/banco"
import { getAuthUser } from "@/server/authz"
import { listEquipmentCards } from "@/server/queries/equipment"
import { getSettings } from "@/server/queries/settings"
import { getRuntime } from "@/server/runtime/registry"

export const metadata: Metadata = { title: banco.title }

const SETUP_ALERT_MS = 24 * 60 * 60 * 1000

/** True while the first-run setup is less than 24 h old (§8.9 "After setup"). */
function setupIsRecent(setupCompletedAt: string | null, now: number): boolean {
  if (!setupCompletedAt) return false
  const at = Date.parse(setupCompletedAt)
  return Number.isFinite(at) && now - at < SETUP_ALERT_MS
}

/** Banco (§8.9): every unit the viewer can see, live. */
export default async function BancoPage() {
  const user = await getAuthUser()
  if (!user) redirect("/login")
  const cards = await listEquipmentCards(user)
  const showSetupAlert = user.isAdmin && setupIsRecent((await getSettings()).setupCompletedAt, new Date().getTime())
  // "Red de equipos": admins see a passive card (link to Sistema) while no network interface is chosen (live afterwards).
  const equipnet = user.isAdmin ? getRuntime().equipnet.status() : null
  return <BancoView cards={cards} showSetupAlert={showSetupAlert} equipnet={equipnet} />
}
