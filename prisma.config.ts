import path from 'node:path'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    seed: 'pnpm tsx prisma/seed.ts',
  },
  datasource: {
    url: 'file:./prisma/dev.db',
  },
})
