// Login check of the upgrade-chain test (no dependencies; run with the bundle's node):
//   node login-check.mjs <base-url> <user> <password>
// Prints the session user and exits 0 when the credentials log in; 1 otherwise. /api/health must answer {ok: true}.
const [base, username, password] = process.argv.slice(2)
const jar = new Map()
const keep = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";")
    const i = kv.indexOf("=")
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1))
  }
}
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
try {
  const health = await (await fetch(`${base}/api/health`)).json()
  if (health.ok !== true) throw new Error(`/api/health: ${JSON.stringify(health)}`)
  const csrfRes = await fetch(`${base}/api/auth/csrf`, { redirect: "manual" })
  keep(csrfRes)
  const { csrfToken } = await csrfRes.json()
  const res = await fetch(`${base}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: base, cookie: cookie(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, username, password, callbackUrl: `${base}/` }).toString(),
  })
  keep(res)
  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: cookie() } })).json()
  const who = session?.user?.username ?? session?.user?.name ?? null
  if (!who) throw new Error(`sin sesión para ${username} (estado ${res.status})`)
  console.log(`versión ${health.version}; sesión de ${who}`)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
