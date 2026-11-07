#!/bin/sh
# Inspect a built image for the two P1 findings (F1 / F2) and for credential leakage.
#
# Why: T5/README asserted F1 (console UI missing from image) and F2 (bots/*.js
# source templates excluded by the `.dockerignore` rule `bots`) from a static
# context calculation. This script turns those assertions into image-level facts.
#
# Run (inside WSL, as root):
#   docker run --rm --entrypoint sh mc-ai-audit:20261107 /mnt/e/.../inspect-image.sh
#
# Prints only paths, sizes and counts. NEVER prints file contents of credentials.
set -u

echo "=== IMAGE IDENTITY ==="
cat /etc/os-release 2>/dev/null | grep -E '^(PRETTY_NAME|VERSION_ID)=' || true
echo "node: $(node --version 2>/dev/null || echo MISSING)"

echo
echo "=== F1: console UI (/web/dist) ==="
# mindserver.js:496 -> path.join(__dirname,'../../../web/dist'); __dirname=/app/src/mindcraft
# => /web/dist  (OUTSIDE /app)
for p in /web /web/dist /app/web /app/web/dist; do
    if [ -e "$p" ]; then
        echo "  EXISTS   $p  ($(ls -1 "$p" 2>/dev/null | wc -l) entries)"
    else
        echo "  MISSING  $p"
    fi
done
echo "  -- any index.html under /web? --"
find /web -maxdepth 3 -name 'index.html' 2>/dev/null | head -n 5 || true

echo
echo "=== F2: bots/*.js source templates ==="
# coder.js reads these at runtime; .dockerignore excludes the whole `bots` dir.
for f in /app/bots/execTemplate.js /app/bots/lintTemplate.js /app/bots; do
    if [ -e "$f" ]; then
        echo "  EXISTS   $f"
    else
        echo "  MISSING  $f"
    fi
done

echo
echo "=== App tree sanity (COPY list) ==="
for f in /app/main.js /app/settings.js /app/src /app/services /app/tasks /app/schematics /app/README.md /app/package.json /app/patches; do
    [ -e "$f" ] && echo "  ok   $f" || echo "  MISS $f"
done

echo
echo "=== Credential leakage (existence only, never contents) ==="
for f in /app/.mindserver-token /app/keys.json /app/.env /app/profiles /app/.git /app/bots/_board /app/logs /app/tmp; do
    [ -e "$f" ] && echo "  LEAK?  $f" || echo "  clean  $f"
done

echo
echo "=== *.token wildcard probe (G1) ==="
find /app -maxdepth 2 -name '*.token' 2>/dev/null | head -n 5 || true
echo "  (empty above = nothing matched)"

echo
echo "=== Package install mode (OPS-007) ==="
grep -n 'npm install\|npm ci' /app/../Dockerfile 2>/dev/null || echo "  (Dockerfile not in image; check build log)"

echo
echo "=== DONE ==="
