/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { BoardForm } from "../board-form"

export default async function NewBoardPage() {
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/boards")
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/boards">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Nueva Placa</h1>
          <p className="text-muted-foreground">
            Configura una nueva placa Devantech
          </p>
        </div>
      </div>

      <BoardForm />
    </div>
  )
}
