#!/bin/sh
# Pipes okta-auth's username, password and TOTP secret straight into the spike
# Worker's secrets. Nothing is printed or written to disk. Run it yourself.
set -eu
cd "$(dirname "$0")"
wrangler="$HOME/.config/moodle-cli/tools/wrangler@4.155.0/node_modules/wrangler/bin/wrangler.js"
okta export --dangerously-print-password-and-totp-secret | node "$wrangler" secret bulk --config wrangler.jsonc
