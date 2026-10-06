// GET /api/system/status (§7.3, W1-C): system info and health, admin only (D29).
import { defineRoute } from "@/server/actions/define-route"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export const GET = defineRoute({ auth: "admin", operation: "system.status" }, async ({ rt }) => {
  const [info, health] = await Promise.all([rt.ops.info(), rt.ops.health.run({ runtimeChecks: true })])
  return Response.json({ info, health })
})
