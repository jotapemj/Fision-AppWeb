cmake_minimum_required(VERSION 3.10.2)

project("soundtouch")

add_library(soundtouch
        SHARED
        soundtouch-jni.cpp
        soundtouch/source/SoundTouch/AAFilter.cpp
        soundtouch/source/SoundTouch/FIFOSampleBuffer.cpp
        soundtouch/source/SoundTouch/FIRFilter.cpp
        soundtouch/source/SoundTouch/cpu_detect_x86.cpp
        soundtouch/source/SoundTouch/RateTransposer.cpp
        soundtouch/source/SoundTouch/SoundTouch.cpp
        soundtouch/source/SoundTouch/TDStretch.cpp
        soundtouch/source/SoundTouch/BPMDetect.cpp
        soundtouch/source/SoundTouch/PeakFinder.cpp
        soundtouch/source/SoundTouch/InterpolateLinear.cpp
        soundtouch/source/SoundTouch/InterpolateCubic.cpp
        soundtouch/source/SoundTouch/InterpolateShannon.cpp)

target_include_directories(soundtouch
        PRIVATE
        soundtouch/config
        soundtouch/include
        soundtouch/source
        soundtouch/source/SoundStretch
        soundtouch/source/SoundTouch
        soundtouch/source/SoundTouchDLL
        soundtouch/source/SoundTouch)

find_library(log-lib
        log)

target_link_libraries(soundtouch
        ${log-lib})
