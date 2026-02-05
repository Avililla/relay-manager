/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getSettings } from "@/actions/settings"
import { SettingsForm } from "./settings-form"

export default async function SettingsPage() {
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/")
  }

  const settings = await getSettings()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Configuracion</h1>
        <p className="text-muted-foreground">
          Ajusta la configuracion global del sistema
        </p>
      </div>

      <SettingsForm settings={settings} />
    </div>
  )
}
