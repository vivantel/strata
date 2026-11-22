#!/bin/sh
# Copy every Claude Code project log of every user on this box into one private archive.
# Why: Claude Code prunes old logs (cleanupPeriodDays), and the index is only as complete as its source.
# Copies, never deletes (no --delete): a log the host later removes stays in the archive.
# Needs read access to other users' homes, so run it as:  sudo sh scripts/archive.sh [DEST] [OWNER]
# Layout: DEST/<user>/<project-dir>/... (whole folders, so subagent files and tool-results come too).
set -eu
DEST="${1:-$HOME/.local/share/strata/archive}"
OWNER="${2:-${SUDO_USER:-$(id -un)}}"
umask 077
[ -d "$(dirname "$DEST")" ] || { echo "parent of $DEST must exist and belong to $OWNER (sudo mkdir -p would make it root-owned)" >&2; exit 1; }
mkdir -p "$DEST"
n=0
for home in /root /home/*; do
  src="$home/.claude/projects"
  [ -d "$src" ] || continue
  user=$(basename "$home")
  mkdir -p "$DEST/$user"
  if command -v rsync >/dev/null 2>&1; then
    rsync -rt --no-perms --no-owner --no-group "$src"/ "$DEST/$user"/
  else
    cp -a -u "$src"/. "$DEST/$user"/
  fi
  n=$((n + 1))
  echo "archived $user"
done
chown -R "$OWNER" "$DEST"
chmod -R go-rwx "$DEST"
echo "done: $n user(s) -> $DEST"
