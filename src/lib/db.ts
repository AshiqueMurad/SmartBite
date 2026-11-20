import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Production logs errors only, so query text and parameters (which can contain user data)
// stay out of the server logs. Development keeps queries and warnings for debugging.
const logLevels: ('query' | 'error' | 'warn')[] =
  process.env.NODE_ENV === 'production' ? ['error'] : ['query', 'error', 'warn']

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: logLevels,
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
