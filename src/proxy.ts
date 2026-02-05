/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { auth } from "@/lib/auth"
import { NextResponse } from "next/server"

export default auth((req) => {
  const isLoggedIn = !!req.auth
  const isOnLogin = req.nextUrl.pathname === "/login"
  const isApiAuth = req.nextUrl.pathname.startsWith("/api/auth")

  // Permitir rutas de autenticación
  if (isApiAuth) {
    return NextResponse.next()
  }

  // Redirigir a dashboard si ya está logueado y está en login
  if (isLoggedIn && isOnLogin) {
    return NextResponse.redirect(new URL("/", req.url))
  }

  // Redirigir a login si no está logueado y no está en login
  if (!isLoggedIn && !isOnLogin) {
    return NextResponse.redirect(new URL("/login", req.url))
  }

  return NextResponse.next()
})

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
