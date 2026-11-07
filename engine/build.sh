#!/usr/bin/env bash
# Compila el motor a WASM.
#   bash engine/build.sh        -> web (public/engine) y node (engine/build/node)
#   bash engine/build.sh web|node|export
# EMSDK = raiz de emsdk (por defecto C:/emsdk o ~/emsdk).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
EMSDK="${EMSDK:-$( [ -d /c/emsdk ] && echo /c/emsdk || echo "$HOME/emsdk" )}"
PY="$(ls -d "$EMSDK"/python/*/ 2>/dev/null | head -1 || true)"
export PATH="$EMSDK/upstream/emscripten:${PY:+$PY:}$PATH"
EMXX=$(command -v em++.exe || command -v em++ || true)
[ -n "$EMXX" ] || { echo "Falta em++ en $EMSDK (instala emsdk o fija EMSDK)" >&2; exit 1; }

ST="$HERE/vendor/soundtouch/lib-soundtouch/src/main/cpp/soundtouch"
SRC=("$HERE/web_api.cpp")
for s in AudioEngine Track WavReader HrtfBank; do SRC+=("$HERE/src/$s.cpp"); done
for s in AAFilter FIFOSampleBuffer FIRFilter RateTransposer SoundTouch TDStretch \
         InterpolateLinear InterpolateCubic InterpolateShannon cpu_detect_x86; do
  SRC+=("$ST/source/SoundTouch/$s.cpp")
done

# Rutas relativas en los __FILE__ de los assert: el binario no lleva la ruta local (usuario del sistema)
MAP=(-ffile-prefix-map="$ROOT"=.)
command -v cygpath >/dev/null && MAP+=(-ffile-prefix-map="$(cygpath -m "$ROOT")"=.)

COMMON=("${MAP[@]}" -std=c++17 -O3 -msimd128 -pthread
  -DSOUNDTOUCH_FLOAT_SAMPLES=1 -DSOUNDTOUCH_DISABLE_X86_OPTIMIZATIONS
  -I"$HERE/shim" -I"$HERE/src" -I"$HERE/vendor" -I"$ST/include" -I"$ST/source/SoundTouch"
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createFisionEngine
  -sWASMFS=1 -sFORCE_FILESYSTEM=1
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB
  -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB
  # Pool de hilos de carga, creado al arrancar (crear hilos luego exige el hilo principal libre)
  -sPTHREAD_POOL_SIZE='Math.min(globalThis.navigator?.hardwareConcurrency||4,8)'
  -sEXPORTED_FUNCTIONS=_malloc,_free
  -Wno-pthreads-mem-growth)

build_web() {
  mkdir -p "$ROOT/public/engine"
  "$EMXX" "${COMMON[@]}" "${SRC[@]}" -DFE_AUDIO_WORKLET=1 \
    -sAUDIO_WORKLET=1 -sWASM_WORKERS=1 -sENVIRONMENT=web,worker \
    -sEXPORTED_RUNTIME_METHODS=FS,stringToNewUTF8,emscriptenRegisterAudioObject,emscriptenGetAudioObject,wasmMemory \
    -o "$ROOT/public/engine/fision_engine.mjs"
  ls -la "$ROOT/public/engine"
}

build_node() {
  mkdir -p "$HERE/build/node"
  "$EMXX" "${COMMON[@]}" "${SRC[@]}" -sENVIRONMENT=node \
    -sEXPORTED_RUNTIME_METHODS=FS,stringToNewUTF8,HEAPF32,wasmMemory \
    -o "$HERE/build/node/fision_engine.mjs"
  ls -la "$HERE/build/node"
}

# Export offline: modulo aparte sin hilos (Worker en web, Node en las pruebas)
EXP=("${MAP[@]}" -std=c++17 -O3 -msimd128 -I"$HERE/shim" -I"$HERE/src" -I"$HERE/vendor"
  "$HERE/export_api.cpp" "$HERE/src/WavReader.cpp"
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createFisionExport -sFORCE_FILESYSTEM=1
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sEXPORTED_FUNCTIONS=_malloc,_free
  -sEXPORTED_RUNTIME_METHODS=FS,stringToNewUTF8,HEAPF32)

build_export() {
  mkdir -p "$ROOT/public/engine" "$HERE/build/node"
  "$EMXX" "${EXP[@]}" -sENVIRONMENT=worker -o "$ROOT/public/engine/fision_export.mjs"
  "$EMXX" "${EXP[@]}" -sENVIRONMENT=node -o "$HERE/build/node/fision_export.mjs"
  ls -la "$ROOT/public/engine/fision_export.wasm" "$HERE/build/node/fision_export.wasm"
}

case "${1:-all}" in
  web) build_web ;;
  node) build_node ;;
  export) build_export ;;
  all) build_web; build_node; build_export ;;
  *) echo "Uso: build.sh [web|node|export|all]" >&2; exit 2 ;;
esac
