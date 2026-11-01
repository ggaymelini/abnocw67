#!/bin/bash
# Rebuild the shareable repo archive for the current HEAD commit.
# Usage: bash /home/z/my-project/scripts/make_repo_zip.sh
set -euo pipefail
cd /home/z/my-project
HASH=$(git rev-parse --short HEAD)
OUT=download/catwar-battle-sim-repo.zip
rm -f "$OUT"
zip -r -q "$OUT" . \
  -x "node_modules/*" ".next/*" ".git/*" "download/*" "sim-backup.git/*" \
  -x "skills/*" "upload/*" "db/*" "tool-results/*" ".config/*" ".claude/*" \
  -x "*.log" "dev.log*" "server.log*" ".env*" ".DS_Store" "*/.DS_Store" \
  -x ".initial_snapshot.json" "tsconfig.tsbuildinfo" \
  -x "game-server/dist/*" "game-server/node_modules/*" \
  -x ".agent-browser/*" ".bun/*" ".cache/*" ".local/*" ".npm/*" ".venv/*" ".zcode/*"
printf '%s' "$HASH" | zip -z "$OUT" > /dev/null
echo "Archive rebuilt: $OUT (commit $HASH, $(du -h "$OUT" | cut -f1))"
