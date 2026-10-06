/** Every integration POST goes through this, so the Origin gate (§2.9) never surprises a test. */
export async function postWithOrigin(url: string, body: unknown, cookie?: string): Promise<Response> {
  const u = new URL(url)
  const isForm = body instanceof URLSearchParams
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: u.origin,
      "content-type": isForm ? "application/x-www-form-urlencoded" : "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: isForm ? body.toString() : JSON.stringify(body),
  })
}
