import type { Metadata } from "next"
import { AuthFrame } from "@/components/auth/auth-frame"
import { SetupForm } from "@/components/auth/setup-form"
import { setup as t } from "@/lib/i18n/admin"
import { getPublicSettings } from "@/server/queries/settings"

export const metadata: Metadata = { title: t.title }

/**
 * First-run setup (§6.6, §8.9). Public while setup is pending (the proxy redirects here, and to /login once done).
 * It shows no health, adapter or board data (D23): only the lab name and version from the public settings.
 */
export default async function SetupPage() {
  const pub = await getPublicSettings()
  return (
    <AuthFrame labName={pub.labName} bannerText={pub.bannerText} version={pub.version} rev={pub.rev} width="wide" heading={t.title}>
      <SetupForm />
    </AuthFrame>
  )
}
