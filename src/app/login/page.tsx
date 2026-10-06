import type { Metadata } from "next"
import { AuthFrame } from "@/components/auth/auth-frame"
import { LoginForm } from "@/components/auth/login-form"
import { auth as t } from "@/lib/i18n/admin"
import { safeNextPath } from "@/lib/safe-next"
import { getPublicSettings } from "@/server/queries/settings"

export const metadata: Metadata = { title: t.loginTitle }

/** Login (§8.9). Public; the proxy sends signed-in users to `/`. `?next=` is honoured only through safeNextPath (§6.5). */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, pub] = await Promise.all([searchParams, getPublicSettings()])
  const next = safeNextPath(typeof sp.next === "string" ? sp.next : "/")
  return (
    <AuthFrame labName={pub.labName} bannerText={pub.bannerText} version={pub.version} rev={pub.rev}>
      <LoginForm next={next} />
    </AuthFrame>
  )
}
