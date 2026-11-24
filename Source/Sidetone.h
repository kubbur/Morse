#pragma once
#include <stdint.h>
#include <stdatomic.h>

enum { MinToneHz=200, MaxToneHz=2000, MinKeyerWPM=5, MaxKeyerWPM=80, MinSpacingWPM=1,
       MinRampMs=1, MaxRampMs=30 };
typedef enum { RaisedCosine, LinearRamp, ExponentialRamp } RampCurve;
enum { UseFarnsworth=1, TimedWordSpaces=2, IambicModeB=4, TrainerGapThresholds=8 };
typedef struct {
    uint16_t pitchHz;
    uint8_t wpm, riseMs, fallMs, curve;
    uint8_t spacingWpm, options;
} ToneSettings;
_Static_assert(sizeof(ToneSettings)==8,"Tone controls fit one atomic load");
typedef _Atomic(ToneSettings) AtomicToneSettings;
extern const ToneSettings defaultToneSettings;
unsigned effectiveWPM(ToneSettings settings);
double spacingUnitMs(ToneSettings settings);
typedef struct { uint32_t rise, fall, last; RampCurve curve; } ToneRamps;
ToneRamps fitToneRamps(ToneSettings settings, double rate, uint32_t frames);
double toneEnvelopeGain(const ToneRamps *ramps, uint32_t frame);
