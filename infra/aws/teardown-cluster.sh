#!/usr/bin/env bash
# Permanently terminates the cluster instance and deletes the security
# group. This is destructive and irreversible — the instance and its EBS
# volume (root volume is delete-on-termination by default) are gone for
# good. Only the key pair is left behind (delete it yourself via
# `aws ec2 delete-key-pair` if you're fully done with this cluster).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/.cluster-state.env"

read -p "This will PERMANENTLY terminate the node in ${REGION}. Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

echo "==> Terminating instance"
aws ec2 terminate-instances --region "$REGION" --instance-ids "$NODE_ID"
aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$NODE_ID"

echo "==> Deleting security group"
aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID" || echo "    (already gone or still in use, skipping)"

echo "==> Done. Key pair '${KEY_NAME}' left intact — delete manually if no longer needed:"
echo "      aws ec2 delete-key-pair --region ${REGION} --key-name ${KEY_NAME}"
