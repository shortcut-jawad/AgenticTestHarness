#!/usr/bin/env bash
# Deletes the local kind cluster created by setup-local-cluster.sh, and
# stops the background cloud-provider-kind process if it's still running.
set -euo pipefail
CLUSTER_NAME="agentic-test-harness"

echo "==> Stopping cloud-provider-kind (if running)"
pkill -f "cloud-provider-kind" 2>/dev/null || true

echo "==> Deleting kind cluster '${CLUSTER_NAME}'"
kind delete cluster --name "$CLUSTER_NAME"
