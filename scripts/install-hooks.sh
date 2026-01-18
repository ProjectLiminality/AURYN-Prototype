#!/bin/bash
# Install git hooks for AURYN
#
# Git hooks live in .git/hooks/ which isn't tracked by git.
# This script copies our hooks from scripts/hooks/ to .git/hooks/
#
# Usage: ./scripts/install-hooks.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
HOOKS_SOURCE="$SCRIPT_DIR/hooks"
HOOKS_TARGET="$REPO_ROOT/.git/hooks"

echo "Installing git hooks..."

for hook in "$HOOKS_SOURCE"/*; do
    hook_name="$(basename "$hook")"
    target="$HOOKS_TARGET/$hook_name"

    cp "$hook" "$target"
    chmod +x "$target"
    echo "  Installed: $hook_name"
done

echo "Done. Git hooks are now active."
