#!/usr/bin/env bash
set -euo pipefail

# Hosted-runner preparation for the Codex escalation probe: Codex's Linux sandbox needs bubblewrap
# with user namespaces, which Ubuntu 24.04 grants only through scripts/configure-ci-bubblewrap.sh.
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap
bash scripts/configure-ci-bubblewrap.sh
