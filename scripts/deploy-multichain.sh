#!/usr/bin/env bash
#
# Deploys SanctionsResolver via CREATE3 to one or more EVM chains using a
# pre-mined salt.  Resulting address is identical on every chain.
#
# Mine the salt once, separately, with:
#   npm run mine:create3-salt -- --prefix=<hex> --account=<eoa>
#
# Then run this script with the resulting salt.
#
# Usage:
#   ./scripts/deploy-multichain.sh \
#     --owner=0xOwnerAddress \
#     [--attester=0xAttesterAddress] \
#     --salt=0x<32-byte-hex> \
#     --networks=sepolia,mainnet,base,optimism
#
# --owner becomes the resolver's `Ownable` owner.  --attester becomes the
# initial trusted attester.  If --attester is omitted it defaults to --owner
# (the canonical "Safe is owner AND attester" setup).  Both can be any address
# (Safe, EOA, multisig, contract); the script doesn't check what's behind it.
#
# Networks must be defined in hardhat.config.ts and have CreateX deployed at
# 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed.  Add new networks to
# hardhat.config.ts and EAS_ADDRESSES in scripts/utils/eas.ts before listing
# them here.

set -euo pipefail

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

OWNER=""
ATTESTER=""
SALT=""
NETWORKS=""

for arg in "$@"; do
  case "$arg" in
    --owner=*)    OWNER="${arg#*=}" ;;
    --attester=*) ATTESTER="${arg#*=}" ;;
    --salt=*)     SALT="${arg#*=}" ;;
    --networks=*) NETWORKS="${arg#*=}" ;;
    -h|--help)    usage ;;
    *)
      echo "unknown argument: $arg" >&2
      usage
      ;;
  esac
done

if [[ -z "$OWNER" || -z "$SALT" || -z "$NETWORKS" ]]; then
  echo "missing required argument(s)" >&2
  usage
fi

# Default attester to owner.  Standard Safe-controlled deploy: same address.
if [[ -z "$ATTESTER" ]]; then
  ATTESTER="$OWNER"
fi

if [[ ! "$OWNER" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "--owner must be a 0x-prefixed 20-byte hex address" >&2
  exit 1
fi
if [[ ! "$ATTESTER" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "--attester must be a 0x-prefixed 20-byte hex address" >&2
  exit 1
fi
if [[ ! "$SALT" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "--salt must be a 0x-prefixed 32-byte hex value" >&2
  exit 1
fi

IFS=',' read -ra NETWORK_LIST <<< "$NETWORKS"

echo "Deploying SanctionsResolver via CREATE3"
echo "  owner    : $OWNER"
echo "  attester : $ATTESTER"
echo "  salt     : $SALT"
echo "  networks : ${NETWORK_LIST[*]}"
echo ""

declare -a SUCCEEDED=()
declare -a FAILED=()

for net in "${NETWORK_LIST[@]}"; do
  net="$(echo "$net" | tr -d '[:space:]')"
  if [[ -z "$net" ]]; then continue; fi

  echo "=========================================="
  echo "Deploying to: $net"
  echo "=========================================="

  # Hardhat 3 doesn't forward unknown CLI flags to the script; pass via env
  # vars instead.  Env vars precede `op run` (per repo convention) so the
  # outer shell exports them before `op run` augments with .env.ref.
  if SALT="$SALT" INITIAL_OWNER="$OWNER" INITIAL_ATTESTER="$ATTESTER" \
       op run --env-file=.env.ref -- \
       npx hardhat run scripts/deploy-create3.ts --network "$net"; then
    SUCCEEDED+=("$net")
  else
    FAILED+=("$net")
    echo ""
    echo "Deploy on $net failed.  Continuing with remaining networks." >&2
  fi
  echo ""
done

echo "=========================================="
echo "Summary"
echo "=========================================="
echo "succeeded: ${SUCCEEDED[*]:-(none)}"
echo "failed   : ${FAILED[*]:-(none)}"

if (( ${#FAILED[@]} > 0 )); then
  exit 1
fi
