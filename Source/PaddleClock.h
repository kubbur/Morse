#pragma once
#include <time.h>

// Contact edges, settings changes and stream snapshots share this Mac clock.
static inline double paddleTimeMs(void) {
    return (double)(clock_gettime_nsec_np(CLOCK_MONOTONIC)/1000)/1000.0;
}
