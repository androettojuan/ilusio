#!/usr/bin/env bash
# Los .wasm se sirven como estáticos desde /public en vez de pasar por el bundler.
# Hay que reejecutarlo si se actualizan opencascade.js o planegcs.
set -e
cd "$(dirname "$0")/.."
mkdir -p public/wasm
cp node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm public/wasm/
cp node_modules/opencascade.js/dist/opencascade.full.wasm public/wasm/
echo "wasm copiado a public/wasm"
