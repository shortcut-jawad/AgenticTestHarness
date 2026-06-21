// ─────────────────────────────────────────────────────────────────────────────
// File: app/api/health/route.ts
// 
// Health check endpoint used by:
//   - Docker HEALTHCHECK
//   - Nginx upstream monitoring
//   - GitHub Actions post-deploy check
//   - Kubernetes liveness/readiness probes (if you go that route)
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'   // adjust path to your prisma client

export async function GET() {
  const start = Date.now()

  try {
    // Ping the database to verify connectivity
    await prisma.$queryRaw`SELECT 1`

    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      responseTime: `${Date.now() - start}ms`,
    })
  } catch (error) {
    // DB is down — return 503 so load balancer removes this instance
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 503 }
    )
  }
}
