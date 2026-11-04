#!/usr/bin/env bash
set -euo pipefail

# Hosted-runner preparation for the Claude Code probe suite: network silence is measured with
# strace, which the hosted image does not ship. The suite proves its own detector with a canary
# (as the unprivileged probe user) and reports could not run when strace cannot trace there.
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y strace
strace -f -qq -e trace=connect -o /dev/null /bin/true
