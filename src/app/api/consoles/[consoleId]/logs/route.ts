// GET /api/consoles/<consoleId>/logs → CaptureFileDTO[] (W1-A, §7.3). `.input.log` files only for admins.
import { z } from "zod"
import { IdSchema } from "@/lib/contracts/common"
import { consoleForUser } from "@/server/access"
import { defineRoute } from "@/server/actions/define-route"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export const GET = defineRoute(
  { auth: "user", params: z.object({ consoleId: IdSchema }), operation: "console.logs" },
  async ({ rt, user, params }) => {
    const c = await consoleForUser(rt.prisma, user, params.consoleId)
    if (!c) return Response.json({ error: "NOT_FOUND" }, { status: 404 })
    return Response.json(await rt.serial.consoles.listCaptureFiles(c.consoleId, { includeInput: user.isAdmin }))
  },
)
