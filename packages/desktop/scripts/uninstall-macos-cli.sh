#!/bin/sh
set -eu

. "$(/usr/bin/dirname "$0")/../resources/macos/pkg-scripts/cli-link.sh"
unregister_codework_cli "/Applications/Codework.app/Contents/Resources/cli/opencode" "/usr/local/bin/opencode"
