import "next-auth"
import "next-auth/jwt"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      username: string
      name: string
      email?: string | null
      image?: string | null
      isAdmin: boolean
      roleIds: string[]
      mustChangePassword: boolean
    }
  }

  interface User {
    username?: string
    sv?: number
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string
    sv?: number
    loginAt?: number
    username?: string
    isAdmin?: boolean
    roleIds?: string[]
    mustChangePassword?: boolean
  }
}
