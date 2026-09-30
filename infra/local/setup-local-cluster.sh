#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-local-cluster.sh
#
# Spins up a local 3-node Kubernetes cluster (via kind) running this app
# from a locally-built Docker image, for demos/screenshots — no cloud
# account, no cost. Uses the SAME k8s/deployment.yaml and k8s/service.yaml
# manifests a real cloud deployment would use; only the database and
# secrets are swapped for local-only equivalents (infra/local/postgres.yaml,
# infra/local/secrets.local.yaml) so the whole thing is self-contained.
#
# Prerequisites: docker, kind, kubectl, cloud-provider-kind
#   brew install kind cloud-provider-kind
#
# Usage:
#   ./infra/local/setup-local-cluster.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="agentic-test-harness"
IMAGE_TAG="agentic-test-harness:local-demo"

cd "$REPO_ROOT"

echo "==> Checking required tools"
for tool in docker kind kubectl cloud-provider-kind; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool (see prerequisites above)"; exit 1; }
done

echo "==> Creating kind cluster '${CLUSTER_NAME}' (1 control-plane + 2 workers)"
if kind get clusters | grep -qx "$CLUSTER_NAME"; then
  echo "    Cluster already exists, reusing."
else
  kind create cluster --name "$CLUSTER_NAME" --config infra/local/kind-config.yaml
fi
kubectl cluster-info --context "kind-${CLUSTER_NAME}"

echo "==> Building the app image"
docker build -t "$IMAGE_TAG" .

echo "==> Loading image into all kind nodes"
kind load docker-image "$IMAGE_TAG" --name "$CLUSTER_NAME"

echo "==> Deploying local Postgres (demo-only, not Supabase)"
kubectl apply -f infra/local/postgres.yaml
kubectl wait --for=condition=ready pod -l app=postgres --timeout=120s

echo "==> Running Prisma migrations against the in-cluster Postgres"
# migrate deploy (not db push) — matches what docker-entrypoint.sh runs on
# every container start, so the _prisma_migrations history table it expects
# actually exists.
kubectl port-forward svc/postgres-service 5433:5432 >/tmp/pf-postgres.log 2>&1 &
PF_PID=$!
trap 'kill $PF_PID 2>/dev/null || true' EXIT
sleep 3
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/agentic_test_harness" \
DIRECT_URL="postgresql://postgres:postgres@localhost:5433/agentic_test_harness" \
  npx prisma migrate deploy
kill $PF_PID 2>/dev/null || true
trap - EXIT

echo "==> Applying local demo secrets"
kubectl apply -f infra/local/secrets.local.yaml

echo "==> Applying the app Deployment + Service (same manifests a real cloud deploy uses)"
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

echo "==> Pointing the Deployment at the locally-built image"
kubectl set image deployment/nextjs-deployment "nextjs-app=${IMAGE_TAG}"
kubectl patch deployment/nextjs-deployment --type=strategic -p \
  '{"spec":{"template":{"spec":{"containers":[{"name":"nextjs-app","imagePullPolicy":"IfNotPresent"}]}}}}'

echo "==> Waiting for all 3 replicas to roll out"
kubectl rollout status deployment/nextjs-deployment --timeout=180s

echo "==> Starting cloud-provider-kind (gives the LoadBalancer Service a real external IP)"
echo "    This runs in the background — leave it running while you demo."
nohup cloud-provider-kind > /tmp/cloud-provider-kind.log 2>&1 &
echo "    PID: $! (log: /tmp/cloud-provider-kind.log)"
sleep 5

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo " Cluster is up. Useful commands for screenshots:"
echo ""
echo "   kubectl get nodes -o wide                 # 3 nodes"
echo "   kubectl get pods -o wide -l app=nextjs-app # 3 app replicas, spread across nodes"
echo "   kubectl get svc nextjs-service              # LoadBalancer with an EXTERNAL-IP"
echo ""
echo " To hit the app (works even if the LB external IP isn't host-reachable):"
echo "   kubectl port-forward svc/nextjs-service 8080:80"
echo "   open http://localhost:8080"
echo "════════════════════════════════════════════════════════════════════"
