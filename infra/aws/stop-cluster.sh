#!/usr/bin/env bash
# Stops the cluster's EC2 instance (no compute charges while stopped, and
# the public IP is released so the ~$3.65/mo IPv4 charge stops too — only
# the negligible EBS storage cost continues). Use start-cluster.sh to bring
# it back up; k3s and the app resume automatically since state lives on the
# (persistent) EBS root volume.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/.cluster-state.env"

echo "==> Stopping node in ${REGION}"
aws ec2 stop-instances --region "$REGION" --instance-ids "$NODE_ID"
echo "    Done. It'll get a NEW public IP when restarted — re-run start-cluster.sh"
echo "    to refresh the kubeconfig and get the new PRODUCTION_URL."
