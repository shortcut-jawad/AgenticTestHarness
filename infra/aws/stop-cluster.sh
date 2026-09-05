#!/usr/bin/env bash
# Stops all 3 cluster EC2 instances (no compute charges while stopped —
# only the negligible EBS storage cost continues). Use start-cluster.sh
# to bring them back up; k3s and the app resume automatically since state
# lives on the (persistent) EBS root volumes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/.cluster-state.env"

echo "==> Stopping node-1, node-2, node-3 in ${REGION}"
aws ec2 stop-instances --region "$REGION" --instance-ids "$NODE1_ID" "$NODE2_ID" "$NODE3_ID"
echo "    Done. They'll get NEW public IPs when restarted — re-run provision's"
echo "    kubeconfig step, or attach Elastic IPs if you want stable addresses."
