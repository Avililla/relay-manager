// GET /api/equipment/[id]/activity (§7.3, W1-C): "Cargar más" of the Actividad tab. Visible equipment only.
import { z } from "zod"
import { IdSchema } from "@/lib/contracts/common"
import { defineRoute } from "@/server/actions/define-route"
import { getEquipmentActivity } from "@/server/queries/equipment"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export const GET = defineRoute(
  {
    auth: "user",
    params: z.object({ id: IdSchema }),
    query: z.object({ cursor: z.coerce.number().int().positive().optional() }),
    operation: "equipment.activity",
  },
  async ({ user, params, query }) => Response.json(await getEquipmentActivity(user, params.id, query.cursor)),
)
