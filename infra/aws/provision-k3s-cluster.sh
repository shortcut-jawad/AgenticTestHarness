#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# provision-k3s-cluster.sh
#
# Provisions a 3-node self-managed k3s cluster on AWS EC2 for this app,
# using the account's default VPC and free-tier-eligible instances.
#
# Prerequisites (on the machine you run this from):
#   - AWS CLI v2, configured with credentials that can create EC2/VPC/SG/KeyPair
#     resources (`aws configure` or an SSO profile)
#   - An SSH client
#
# What it does:
#   1. Looks up the default VPC + a subnet in it, and the latest Ubuntu 22.04 AMI
#   2. Creates a key pair (saves the .pem locally, gitignored) and a security group
#   3. Launches node-1 with user-data that installs k3s in server mode
#   4. SSHes into node-1 to grab its node-token, then launches node-2 and
#      node-3 with user-data that joins them as agents
#   5. Prints the kubeconfig (with the public IP substituted in) to store as
#      the GitHub Actions `KUBE_CONFIG` secret, plus the 3 node public IPs
#
# COST NOTE: AWS Free Tier gives 750 instance-hours/month TOTAL for eligible
# instance types — not 750 hours *per* instance. Running all 3 nodes 24/7 is
# ~2,190 hours/month, so ~1,440 hours/month fall outside the free tier and
# bill at the (small) on-demand rate for INSTANCE_TYPE — a few dollars/month,
# not zero. Use stop-cluster.sh / start-cluster.sh (in this same directory)
# to shut the nodes down when you're not using them if you want to stay
# closer to the free allowance.
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
    --group-name "$SG_NAME" --description "k3s cluster for ${CLUSTER_NAME}" --vpc-id "$VPC_ID" \
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

  # Cluster-internal only: flannel VXLAN + kubelet, from other cluster nodes
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol udp --port 8472 --source-group "$SG_ID" >/dev/null
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 10250 --source-group "$SG_ID" >/dev/null
  echo "    Created ${SG_ID}"
else
  echo "    Security group already exists, reusing ${SG_ID}"
fi

launch_node() {
  local name="$1" user_data="$2"
  aws ec2 run-instances --region "$REGION" \
    --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" --security-group-ids "$SG_ID" --subnet-id "$SUBNET_ID" \
    --associate-public-ip-address \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${name}},{Key=Cluster,Value=${CLUSTER_NAME}}]" \
    --user-data "$user_data" \
    --query 'Instances[0].InstanceId' --output text
}

wait_for_ssh_ready() {
  local instance_id="$1"
  aws ec2 wait instance-status-ok --region "$REGION" --instance-ids "$instance_id"
}

get_public_ip() {
  aws ec2 describe-instances --region "$REGION" --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
}

get_private_ip() {
  aws ec2 describe-instances --region "$REGION" --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text
}

ssh_node() {
  local ip="$1"; shift
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$KEY_PATH" "ubuntu@${ip}" "$@"
}

echo "==> Launching node-1 (k3s server)"
NODE1_USER_DATA='#!/bin/bash
curl -sfL https://get.k3s.io | sh -s - server --write-kubeconfig-mode 644'
NODE1_ID=$(launch_node "${CLUSTER_NAME}-node-1" "$NODE1_USER_DATA")
echo "    Instance: ${NODE1_ID}, waiting for it to boot and pass status checks..."
wait_for_ssh_ready "$NODE1_ID"
NODE1_PUBLIC_IP=$(get_public_ip "$NODE1_ID")
NODE1_PRIVATE_IP=$(get_private_ip "$NODE1_ID")
echo "    node-1 public=${NODE1_PUBLIC_IP} private=${NODE1_PRIVATE_IP}"

echo "==> Waiting for k3s server to finish installing on node-1 (polling for node-token)"
for i in $(seq 1 30); do
  if ssh_node "$NODE1_PUBLIC_IP" "sudo test -f /var/lib/rancher/k3s/server/node-token" 2>/dev/null; then
    break
  fi
  echo "    still waiting... (${i}/30)"
  sleep 10
done
NODE_TOKEN=$(ssh_node "$NODE1_PUBLIC_IP" "sudo cat /var/lib/rancher/k3s/server/node-token")
echo "    Got node token."

launch_agent() {
  local name="$1"
  local user_data="#!/bin/bash
curl -sfL https://get.k3s.io | K3S_URL=https://${NODE1_PRIVATE_IP}:6443 K3S_TOKEN=${NODE_TOKEN} sh -"
  launch_node "$name" "$user_data"
}

echo "==> Launching node-2 (k3s agent)"
NODE2_ID=$(launch_agent "${CLUSTER_NAME}-node-2")
echo "==> Launching node-3 (k3s agent)"
NODE3_ID=$(launch_agent "${CLUSTER_NAME}-node-3")

echo "    Waiting for node-2 and node-3 to boot..."
wait_for_ssh_ready "$NODE2_ID"
wait_for_ssh_ready "$NODE3_ID"
NODE2_PUBLIC_IP=$(get_public_ip "$NODE2_ID")
NODE3_PUBLIC_IP=$(get_public_ip "$NODE3_ID")

echo "==> Waiting ~30s for agents to register with the cluster"
sleep 30

echo "==> Cluster nodes:"
ssh_node "$NODE1_PUBLIC_IP" "sudo k3s kubectl get nodes -o wide"

echo "==> Fetching kubeconfig (substituting node-1's public IP for 127.0.0.1)"
KUBECONFIG_CONTENT=$(ssh_node "$NODE1_PUBLIC_IP" "sudo cat /etc/rancher/k3s/k3s.yaml" | sed "s/127.0.0.1/${NODE1_PUBLIC_IP}/")
KUBECONFIG_PATH="${SCRIPT_DIR}/kubeconfig-${CLUSTER_NAME}.yaml"
echo "$KUBECONFIG_CONTENT" > "$KUBECONFIG_PATH"
echo "    Saved to ${KUBECONFIG_PATH} (gitignored — do not commit this file)"

cat > "$STATE_FILE" <<EOF
REGION=${REGION}
NODE1_ID=${NODE1_ID}
NODE2_ID=${NODE2_ID}
NODE3_ID=${NODE3_ID}
NODE1_PUBLIC_IP=${NODE1_PUBLIC_IP}
NODE2_PUBLIC_IP=${NODE2_PUBLIC_IP}
NODE3_PUBLIC_IP=${NODE3_PUBLIC_IP}
SG_ID=${SG_ID}
KEY_NAME=${KEY_NAME}
EOF

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo " Cluster is up. Next steps:"
echo ""
echo " 1. Create the app-secrets Secret (fill in k8s/secrets.example.yaml,"
echo "    save as k8s/secrets.yaml, then):"
echo "      KUBECONFIG=${KUBECONFIG_PATH} kubectl apply -f k8s/secrets.yaml"
echo ""
echo " 2. Add these as GitHub Actions repo secrets:"
echo "      KUBE_CONFIG    = contents of ${KUBECONFIG_PATH}"
echo "      PRODUCTION_URL = http://${NODE1_PUBLIC_IP}"
echo ""
echo " 3. Push to main (or re-run the CD workflow) to deploy the app."
echo ""
echo " Node public IPs (any of these serves the load-balanced app on :80"
echo " once deployed): ${NODE1_PUBLIC_IP}, ${NODE2_PUBLIC_IP}, ${NODE3_PUBLIC_IP}"
echo "════════════════════════════════════════════════════════════════════"
