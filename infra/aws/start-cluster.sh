#!/usr/bin/env bash
# Starts the 3 cluster EC2 instances back up after stop-cluster.sh, and
# refreshes the local kubeconfig + prints the new PRODUCTION_URL — instances
# get a fresh public IP each time they're stopped/started, so both the
# GitHub `KUBE_CONFIG` secret and `PRODUCTION_URL` secret need updating after
# every restart.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="agentic-test-harness-k3s"
KEY_PATH="${SCRIPT_DIR}/${CLUSTER_NAME}-key.pem"
source "${SCRIPT_DIR}/.cluster-state.env"

echo "==> Starting node-1, node-2, node-3 in ${REGION}"
aws ec2 start-instances --region "$REGION" --instance-ids "$NODE1_ID" "$NODE2_ID" "$NODE3_ID" >/dev/null

echo "==> Waiting for instances to pass status checks"
aws ec2 wait instance-status-ok --region "$REGION" --instance-ids "$NODE1_ID" "$NODE2_ID" "$NODE3_ID"

NODE1_PUBLIC_IP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$NODE1_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
NODE2_PUBLIC_IP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$NODE2_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
NODE3_PUBLIC_IP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$NODE3_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

echo "==> Refreshing kubeconfig with the new public IP"
KUBECONFIG_PATH="${SCRIPT_DIR}/kubeconfig-${CLUSTER_NAME}.yaml"
ssh -o StrictHostKeyChecking=no -i "$KEY_PATH" "ubuntu@${NODE1_PUBLIC_IP}" "sudo cat /etc/rancher/k3s/k3s.yaml" \
  | sed "s/127.0.0.1/${NODE1_PUBLIC_IP}/" > "$KUBECONFIG_PATH"

# Update state file with the new IPs
sed -i.bak "s/^NODE1_PUBLIC_IP=.*/NODE1_PUBLIC_IP=${NODE1_PUBLIC_IP}/" "${SCRIPT_DIR}/.cluster-state.env"
sed -i.bak "s/^NODE2_PUBLIC_IP=.*/NODE2_PUBLIC_IP=${NODE2_PUBLIC_IP}/" "${SCRIPT_DIR}/.cluster-state.env"
sed -i.bak "s/^NODE3_PUBLIC_IP=.*/NODE3_PUBLIC_IP=${NODE3_PUBLIC_IP}/" "${SCRIPT_DIR}/.cluster-state.env"
rm -f "${SCRIPT_DIR}/.cluster-state.env.bak"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo " Cluster is back up. Update your GitHub secrets:"
echo "   KUBE_CONFIG    = contents of ${KUBECONFIG_PATH}"
echo "   PRODUCTION_URL = http://${NODE1_PUBLIC_IP}"
echo " Node IPs: ${NODE1_PUBLIC_IP}, ${NODE2_PUBLIC_IP}, ${NODE3_PUBLIC_IP}"
echo "════════════════════════════════════════════════════════════════════"
