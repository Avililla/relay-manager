import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { FilesView } from "@/components/files/files-view"
import { filesUi } from "@/lib/i18n/files"
import { getFilesPage } from "@/server/queries/files"
import { userPage } from "../sistema/_lib/guard"

export const metadata: Metadata = { title: filesUi.title }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/** Archivos (all users): the shared folders of the bench host. `?raiz=tftp|extra` (tftp by default), `?ruta=<carpeta relativa>`. */
export default async function ArchivosPage({ searchParams }: Props) {
  const sp = await searchParams
  const user = await userPage()
  if (user.mustChangePassword) redirect("/cuenta?cambiar=1")
  const raiz = typeof sp.raiz === "string" ? sp.raiz : undefined
  const ruta = typeof sp.ruta === "string" ? sp.ruta : ""
  return <FilesView data={await getFilesPage(user, raiz, ruta)} />
}
