#!/usr/bin/env bash
# The only step of INSTALL.md that needs root: system packages, cron running, linger for the rig user,
# and the Claude Code channel permission. Safe to run again.
# Usage: curl -fsSL <raw url of this file> | sudo bash -s -- "$USER"
set -eu

user_name="${1:?usage: prepare-server.sh <user>}"
settings_file="${RIG_MANAGED_SETTINGS:-/etc/claude-code/managed-settings.json}"
settings='{"channelsEnabled":true,"allowedChannelPlugins":[{"plugin":"telegram-hub","marketplace":"telegram-hub"}]}'

# Checked first, so a conflict leaves the machine untouched. A file that already allows the channel stays as it is.
if [ -e "$settings_file" ] && ! { grep -q '"allowedChannelPlugins"' "$settings_file" && grep -q '"telegram-hub"' "$settings_file"; }; then
	printf 'File %s already exists. Nothing was changed. Add these keys to it by hand and run again:\n%s\n' "$settings_file" "$settings" >&2
	exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git python3 bash cron tmux unzip ca-certificates curl nodejs
systemctl enable --now cron
loginctl enable-linger "$user_name"

mkdir -p "$(dirname "$settings_file")"
[ -e "$settings_file" ] || printf '%s\n' "$settings" > "$settings_file"
printf 'Server prepared for %s.\n' "$user_name"
