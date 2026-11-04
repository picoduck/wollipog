#!/usr/bin/env bash
set -euo pipefail

# Hosted-runner preparation for the Pi probe suite: every probe group runs inside a bubblewrap network
# namespace, which Ubuntu 24.04 grants only through scripts/configure-ci-bubblewrap.sh. The suite
# verifies that namespace itself and reports could not run when it is unavailable.
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap
bash scripts/configure-ci-bubblewrap.sh
/usr/bin/bwrap --bind / / --dev /dev --unshare-net --die-with-parent -- /bin/true
