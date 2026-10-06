import type { NextRequest } from "next/server"
import { handlers } from "@/server/auth"
import { withHostOrigin } from "@/server/auth/host-origin"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Host-origin wrapper (§6.4): request.url is rebuilt from Host, never from forwarded headers.
export const GET = (req: NextRequest) => handlers.GET(withHostOrigin(req))
export const POST = (req: NextRequest) => handlers.POST(withHostOrigin(req))
