import NextAuth from "next-auth"
import { buildAuthConfig } from "./config"

// Eager config: the lazy form makes `auth(handler)` return a Promise, which the Next proxy rejects.
// Building the config only reads process.env (set by applyConfigEnv before Next loads any route); no I/O.
export const { handlers, auth, signIn, signOut } = NextAuth(buildAuthConfig())
