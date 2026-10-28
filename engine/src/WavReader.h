#pragma once
#include <vector>
#include <string>

struct WavData{
    int sampleRate = 0;
    int channels   = 0;
    std::vector<float> pcm; // intercalado
};

// Carga WAV PCM16 o IEEE float32 (little-endian) a float [-1,1]
bool loadWavPcmToFloat(const char* path, WavData& out);
