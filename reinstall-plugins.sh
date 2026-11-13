#!/usr/bin/env bash
# Reinstall the three local bundles under their new @yf-river scope.
#
# The rename from @local/* to @yf-river/* left the profile pointing at package
# names that no longer exist. dsh resolves a bundle by the name in its patch
# row, so the old entries fail to load until they are re-added under the new
# names. Run this once after restarting dsh.
set -euo pipefail

PLUGINS=/data/ida/ai/dsh-skills/plugins
PROFILE=web

echo "== Removing old @local entries =="
for name in dsh-pinned-sessions dsh-agent-eyes dsh-restart-button; do
  dsh plugin --profile "$PROFILE" remove "@local/$name" 2>/dev/null \
    && echo "  removed @local/$name" \
    || echo "  @local/$name not present (already gone)"
done

echo
echo "== Installing under @yf-river =="
for name in dsh-pinned-sessions dsh-agent-eyes dsh-restart-button; do
  dsh plugin --profile "$PROFILE" add "$PLUGINS/$name"
  echo "  added $name"
done

echo
echo "== Verifying =="
node -e "
const j = require('/root/.dsh/profiles/$PROFILE/package.json')
const names = Object.keys(j.dependencies || {}).filter(k => k.startsWith('@yf-river/'))
console.log('  installed:', names.join(', ') || '(none)')
const bundles = (j.dsh?.profile?.bundles || []).filter(b => b.startsWith('@yf-river/'))
console.log('  bundles  :', bundles.join(', ') || '(none)')
if (names.length !== 3) { console.error('  EXPECTED 3, got ' + names.length); process.exit(1) }
"
echo
echo "Restart the service so the new rows load:"
echo "  systemctl restart dsh-web"
