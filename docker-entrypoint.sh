#!/bin/sh
set -e

echo "Running Prisma migrations..."
npx prisma migrate deploy --schema=/app/prisma/schema.prisma

echo "Ensuring uploads directory exists..."
mkdir -p /app/uploads/agent-logs

echo "Starting Next.js server..."
exec node server.js
