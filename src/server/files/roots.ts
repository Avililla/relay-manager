// Labels of the roots of Archivos (no service code here: the pages import it).
import type { FilesRootId } from "@/lib/contracts/files"
import type { AppConfig } from "@/server/config/schema"

/** The label and description of a root in Archivos: «tftp», or the second folder named by the profile. */
export function filesRootLabel(files: AppConfig["files"], root: FilesRootId): { label: string; hint: string } {
  return root === "extra"
    ? { label: files.extraName, hint: files.extraHint }
    : { label: "tftp", hint: "Imágenes y archivos para los equipos (~/tftp)" }
}
