import { redirect } from "next/navigation"
import { AppProviders } from "@/components/providers/app-providers"
import { AppShell } from "@/components/shell/app-shell"
import { getAuthUser } from "@/server/authz"
import { getShellData } from "@/server/queries/shell"

/** Every authenticated page renders inside the shell (§8.1, §8.8). */
export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getAuthUser()
  if (!user) redirect("/login")
  const shell = await getShellData(user)
  return (
    <AppProviders shell={shell}>
      <AppShell>{children}</AppShell>
    </AppProviders>
  )
}
