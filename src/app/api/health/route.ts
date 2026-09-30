// ─────────────────────────────────────────────────────────────────────────────
// File: app/api/health/route.ts
// 
// Health check endpoint used by:
//   - Docker HEALTHCHECK
//   - GitHub Actions post-deploy check
//   - Kubernetes liveness/readiness probes
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server'
import { hostname } from 'os'
import { prisma } from '@/lib/prisma'   // adjust path to your prisma client

export async function GET() {
  const start = Date.now()
  // Kubernetes sets the container hostname to the pod name — surfacing it
  // here makes it easy to confirm requests are actually being spread across
  // replicas rather than always hitting the same instance.
  const instance = hostname()

  try {
    // Ping the database to verify connectivity
    await prisma.$queryRaw`SELECT 1`

    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      responseTime: `${Date.now() - start}ms`,
      instance,
    })
  } catch (error) {
    // DB is down — return 503 so load balancer removes this instance
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error',
        instance,
      },
      { status: 503 }
    )
  }
}
