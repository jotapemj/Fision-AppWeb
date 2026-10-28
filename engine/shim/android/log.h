// Shim de android/log.h: vuelca a stderr (console en el navegador)
#pragma once
#include <cstdarg>
#include <cstdio>

enum { ANDROID_LOG_DEBUG = 3, ANDROID_LOG_INFO = 4, ANDROID_LOG_WARN = 5, ANDROID_LOG_ERROR = 6 };

inline int __android_log_print(int prio, const char* tag, const char* fmt, ...) {
    std::fprintf(stderr, "%c/%s: ", prio >= ANDROID_LOG_ERROR ? 'E' : 'I', tag);
    va_list ap;
    va_start(ap, fmt);
    std::vfprintf(stderr, fmt, ap);
    va_end(ap);
    std::fputc('\n', stderr);
    return 0;
}
