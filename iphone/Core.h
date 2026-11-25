#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "ElementStream.h"

typedef struct PhoneCore PhoneCore;
unsigned phoneQueueFrames(double rate, double hardwareBufferSeconds);
PhoneCore *phoneCreate(double rate);
void phoneDestroy(PhoneCore *core);
void phonePilots(PhoneCore *core, float *stereo, unsigned frames);
enum { PhonePilotLoopRate = 48000 };
void phonePilotLoopPCM16(int16_t *stereo);
void phoneInput(PhoneCore *core, float *interleaved, unsigned frames, unsigned channels);
void phoneSpeaker(PhoneCore *core, float *mono, unsigned frames);
void phoneSound(PhoneCore *core, unsigned wpm, unsigned spacing, unsigned pitch,
                unsigned volume, unsigned rise, unsigned fall, unsigned curve, bool modeB);
void phoneMute(PhoneCore *core, bool muted);
void phoneReverse(PhoneCore *core, bool reverse);
void phoneInvalidate(PhoneCore *core);
bool phoneReady(PhoneCore *core);
unsigned phoneMask(PhoneCore *core);
unsigned phoneEpoch(PhoneCore *core);
bool phoneEvent(PhoneCore *core, ElementEvent *event);
uint64_t phoneAudibleFrames(PhoneCore *core);

// A probe reads one or two interleaved input channels independently. A reading
// spans 25 complete 10 ms windows with the same acknowledged output setting.
typedef struct PhoneSignalMeter PhoneSignalMeter;
typedef struct { double rms, peak, tone[2]; } PhoneSignalLevel;
typedef struct {
    unsigned outputTag, ordinal, frames;
    uint64_t endFrame;
    PhoneSignalLevel channels[2];
} PhoneSignalReading;
PhoneSignalMeter *phoneMeterCreate(unsigned channels);
void phoneMeterDestroy(PhoneSignalMeter *meter);
void phoneMeterInput(PhoneSignalMeter *meter, const float *input, unsigned frames, unsigned outputTag);
bool phoneMeterRead(PhoneSignalMeter *meter, PhoneSignalReading *reading);
