#!/usr/bin/env bash
# Starts the cluster's EC2 instance back up after stop-cluster.sh, and
# refreshes the local kubeconfig + prints the new PRODUCTION_URL — the
# instance gets a fresh public IP each time it's stopped/started, so both
# the GitHub `KUBE_CONFIG` secret and `PRODUCTION_URL` secret need updating
# after every restart.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="agentic-test-harness-k3s"
KEY_PATH="${SCRIPT_DIR}/${CLUSTER_NAME}-key.pem"
source "${SCRIPT_DIR}/.cluster-state.env"

echo "==> Starting node in ${REGION}"
aws ec2 start-instances --region "$REGION" --instance-ids "$NODE_ID" >/dev/null

echo "==> Waiting for the instance to pass status checks"
aws ec2 wait instance-status-ok --region "$REGION" --instance-ids "$NODE_ID"

NODE_PUBLIC_IP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$NODE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

echo "==> Refreshing kubeconfig with the new public IP"
KUBECONFIG_PATH="${SCRIPT_DIR}/kubeconfig-${CLUSTER_NAME}.yaml"
ssh -o StrictHostKeyChecking=no -i "$KEY_PATH" "ubuntu@${NODE_PUBLIC_IP}" "sudo cat /etc/rancher/k3s/k3s.yaml" \
  | sed "s/127.0.0.1/${NODE_PUBLIC_IP}/" > "$KUBECONFIG_PATH"

sed -i.bak "s/^NODE_PUBLIC_IP=.*/NODE_PUBLIC_IP=${NODE_PUBLIC_IP}/" "${SCRIPT_DIR}/.cluster-state.env"
rm -f "${SCRIPT_DIR}/.cluster-state.env.bak"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo " Node is back up. Update your GitHub secrets:"
echo "   KUBE_CONFIG    = contents of ${KUBECONFIG_PATH}"
echo "   PRODUCTION_URL = http://${NODE_PUBLIC_IP}"
echo "════════════════════════════════════════════════════════════════════"
