import type { Metadata } from "next"
import { HealthPanel } from "@/components/admin/health-panel"
import { system as t } from "@/lib/i18n/admin"
import { getHealth } from "@/server/queries/system"
import { adminPage } from "../_lib/guard"

export const metadata: Metadata = { title: `${t.tabs.salud} · ${t.title}` }

/** Sistema > Salud: the runtime health checks, grouped, with hints and "Volver a comprobar". */
export default async function SistemaSaludPage() {
  await adminPage()
  const checks = await getHealth()
  return <HealthPanel initial={checks} checkedAt={new Date().toISOString()} />
}
