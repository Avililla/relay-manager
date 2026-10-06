import { tryGetRuntime } from "@/server/runtime/registry"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "cache-control": "no-store" }

/** Public health (D29): only {ok, version}. Excluded from the proxy matcher. */
export async function GET(): Promise<Response> {
  const rt = tryGetRuntime()
  try {
    if (!rt) throw new Error("runtime not ready")
    await rt.prisma.$queryRawUnsafe("SELECT 1")
    return Response.json({ ok: true, version: rt.config.build.version }, { headers: NO_STORE })
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: NO_STORE })
  }
}
