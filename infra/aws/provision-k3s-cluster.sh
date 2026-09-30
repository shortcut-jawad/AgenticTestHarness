#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# provision-k3s-cluster.sh
#
# Provisions a SINGLE-NODE k3s cluster on one free-tier-eligible AWS EC2
# instance for this app, using the account's default VPC.
#
# Why single-node: this app has negligible traffic, and AWS has no way to
# run an internet-facing instance at literal $0 — every public IPv4 address
# has cost ~$0.005/hr (~$3.65/mo) since AWS's Feb 2024 pricing change,
# regardless of instance count or size. Adding more nodes only adds more of
# that same per-IP charge for no real benefit here, so this provisions the
# minimum: one node, acting as both k3s server and the only worker, running
# 2 app replicas for basic redundancy (see k8s/deployment.yaml).
#
# Prerequisites (on the machine you run this from):
#   - AWS CLI v2, configured with credentials that can create EC2/VPC/SG/KeyPair
#     resources (`aws configure` or an SSO profile)
#   - An SSH client
#
# What it does:
#   1. Looks up the default VPC + a subnet in it, and the latest Ubuntu 22.04 AMI
#   2. Creates a key pair (saves the .pem locally, gitignored) and a security group
#   3. Launches the node with user-data that installs k3s in server mode
#   4. SSHes in to fetch the kubeconfig (with the public IP substituted in)
#
# COST NOTE: the ~$3.65/mo public-IP charge above is unavoidable for any
# internet-facing AWS instance. Instance-hours themselves fit inside the
# account's free-tier allowance (750 hrs/month) for a single always-on
# t3.micro/t2.micro. Use stop-cluster.sh / start-cluster.sh (in this same
# directory) if you want to avoid even the IP charge while not using it —
# stopping releases the public IP, so it's billed only while running.
#
# Usage:
#   chmod +x infra/aws/provision-k3s-cluster.sh
#   ./infra/aws/provision-k3s-cluster.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.micro}"   # switch to t2.micro if that's what your account's free tier covers
CLUSTER_NAME="agentic-test-harness-k3s"
KEY_NAME="${CLUSTER_NAME}-key"
SG_NAME="${CLUSTER_NAME}-sg"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_PATH="${SCRIPT_DIR}/${KEY_NAME}.pem"
STATE_FILE="${SCRIPT_DIR}/.cluster-state.env"

echo "==> Region: ${REGION}, instance type: ${INSTANCE_TYPE}"

echo "==> Looking up default VPC and a subnet in it"
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNET_ID=$(aws ec2 describe-subnets --region "$REGION" --filters "Name=vpc-id,Values=${VPC_ID}" --query 'Subnets[0].SubnetId' --output text)
echo "    VPC: ${VPC_ID}  Subnet: ${SUBNET_ID}"

echo "==> Looking up latest Ubuntu 22.04 AMI"
AMI_ID=$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)
echo "    AMI: ${AMI_ID}"

echo "==> Creating key pair (${KEY_NAME})"
if aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
  echo "    Key pair already exists, reusing. (Make sure you still have ${KEY_PATH})"
else
  aws ec2 create-key-pair --region "$REGION" --key-name "$KEY_NAME" \
    --query 'KeyMaterial' --output text > "$KEY_PATH"
  chmod 400 "$KEY_PATH"
  echo "    Saved private key to ${KEY_PATH}"
fi

MY_IP=$(curl -s https://checkip.amazonaws.com)
echo "==> Your public IP for SSH access: ${MY_IP}"

echo "==> Creating security group (${SG_NAME})"
SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=${SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")

if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "$SG_NAME" --description "k3s single-node cluster for ${CLUSTER_NAME}" --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)

  # SSH — restricted to your current IP only
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr "${MY_IP}/32" >/dev/null

  # k3s API server (kube-apiserver) — needed publicly so GitHub Actions'
  # kubectl can reach it. Protected by TLS client-cert auth, not open access.
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 6443 --cidr 0.0.0.0/0 >/dev/null

  # App traffic via k3s's built-in ServiceLB
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  echo "    Created ${SG_ID}"
else
  echo "    Security group already exists, reusing ${SG_ID}"
fi

wait_for_ssh_ready() {
  aws ec2 wait instance-status-ok --region "$REGION" --instance-ids "$1"
}

get_public_ip() {
  aws ec2 describe-instances --region "$REGION" --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
}

ssh_node() {
  local ip="$1"; shift
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$KEY_PATH" "ubuntu@${ip}" "$@"
}

echo "==> Launching node (k3s server, single-node)"
USER_DATA='#!/bin/bash
curl -sfL https://get.k3s.io | sh -s - server --write-kubeconfig-mode 644'
NODE_ID=$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" --security-group-ids "$SG_ID" --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${CLUSTER_NAME}-node},{Key=Cluster,Value=${CLUSTER_NAME}}]" \
  --user-data "$USER_DATA" \
  --query 'Instances[0].InstanceId' --output text)
echo "    Instance: ${NODE_ID}, waiting for it to boot and pass status checks..."
wait_for_ssh_ready "$NODE_ID"
NODE_PUBLIC_IP=$(get_public_ip "$NODE_ID")
echo "    node public IP: ${NODE_PUBLIC_IP}"

echo "==> Waiting for k3s to finish installing (polling for kubeconfig)"
for i in $(seq 1 30); do
  if ssh_node "$NODE_PUBLIC_IP" "sudo test -f /etc/rancher/k3s/k3s.yaml" 2>/dev/null; then
    break
  fi
  echo "    still waiting... (${i}/30)"
  sleep 10
done

echo "==> Node status:"
ssh_node "$NODE_PUBLIC_IP" "sudo k3s kubectl get nodes -o wide"

echo "==> Fetching kubeconfig (substituting node's public IP for 127.0.0.1)"
KUBECONFIG_CONTENT=$(ssh_node "$NODE_PUBLIC_IP" "sudo cat /etc/rancher/k3s/k3s.yaml" | sed "s/127.0.0.1/${NODE_PUBLIC_IP}/")
KUBECONFIG_PATH="${SCRIPT_DIR}/kubeconfig-${CLUSTER_NAME}.yaml"
echo "$KUBECONFIG_CONTENT" > "$KUBECONFIG_PATH"
echo "    Saved to ${KUBECONFIG_PATH} (gitignored — do not commit this file)"

cat > "$STATE_FILE" <<EOF
REGION=${REGION}
NODE_ID=${NODE_ID}
NODE_PUBLIC_IP=${NODE_PUBLIC_IP}
SG_ID=${SG_ID}
KEY_NAME=${KEY_NAME}
EOF

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo " Node is up. Next steps:"
echo ""
echo " 1. Create the app-secrets Secret (fill in k8s/secrets.example.yaml,"
echo "    save as k8s/secrets.yaml, then):"
echo "      KUBECONFIG=${KUBECONFIG_PATH} kubectl apply -f k8s/secrets.yaml"
echo ""
echo " 2. Add these as GitHub Actions repo secrets:"
echo "      KUBE_CONFIG    = contents of ${KUBECONFIG_PATH}"
echo "      PRODUCTION_URL = http://${NODE_PUBLIC_IP}"
echo ""
echo " 3. Push to main (or re-run the CD workflow) to deploy the app."
echo ""
echo " Estimated recurring cost: ~\$3.65/mo (the public IPv4 charge) as long"
echo " as this instance keeps running — that floor is unavoidable for any"
echo " internet-facing AWS instance. Use stop-cluster.sh when not in use."
echo "════════════════════════════════════════════════════════════════════"
