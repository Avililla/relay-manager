/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { DefaultSession, DefaultUser } from "next-auth"
import { JWT, DefaultJWT } from "next-auth/jwt"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      isAdmin: boolean
      roleIds: string[]
      roleNames: string[]
    } & DefaultSession["user"]
  }

  interface User extends DefaultUser {
    isAdmin: boolean
    roleIds: string[]
    roleNames: string[]
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    id: string
    isAdmin: boolean
    roleIds: string[]
    roleNames: string[]
  }
}
