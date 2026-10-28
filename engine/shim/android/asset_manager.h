// Shim de AAssetManager sobre FILE* (ficheros en el FS de Emscripten).
// El "mgr" se ignora; la ruta es absoluta en el FS virtual.
#pragma once
#include <cstdio>

struct AAssetManager;
struct AAsset { std::FILE* f; };

enum { AASSET_MODE_UNKNOWN = 0, AASSET_MODE_RANDOM = 1, AASSET_MODE_STREAMING = 2, AASSET_MODE_BUFFER = 3 };

inline AAsset* AAssetManager_open(AAssetManager*, const char* path, int) {
    std::FILE* f = std::fopen(path, "rb");
    return f ? new AAsset{f} : nullptr;
}
inline int AAsset_read(AAsset* a, void* buf, size_t n) { return (int)std::fread(buf, 1, n, a->f); }
inline void AAsset_close(AAsset* a) { std::fclose(a->f); delete a; }
