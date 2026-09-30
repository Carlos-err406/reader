#!/usr/bin/env bash
# Regenerates every app icon from assets/icon.svg.
# Android's adaptive icon needs a separate foreground (the book alone, inside the safe zone)
# over a solid background colour; otherwise launcher masks show the square's corners.
set -euo pipefail
cd "$(dirname "$0")/.."
res=src-tauri/gen/android/app/src/main/res
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pnpm tauri icon assets/icon.svg
rm -rf src-tauri/icons/ios src-tauri/icons/android
pnpm tauri icon assets/icon-foreground.svg -o "$tmp"
for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  cp "$tmp/android/mipmap-$density/ic_launcher_foreground.png" "$res/mipmap-$density/"
done
sed -i '' 's/<color name="ic_launcher_background">.*</<color name="ic_launcher_background">#1F3A5F</' "$res/values/ic_launcher_background.xml"
