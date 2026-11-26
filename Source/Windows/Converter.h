#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "../PaddleCalibration.h"

#ifdef __cplusplus
extern "C" {
#endif
typedef struct Converter Converter;
typedef struct { double on[2], off[2]; bool boosted; } ConverterProfile;
typedef struct { unsigned wpm, spacing, pitch, volume, rise, fall, curve; bool modeB, spaces, reverse; } ConverterSettings;
typedef struct { uint64_t frame; double rate; unsigned epoch, kind; } ConverterEdge;
typedef struct { unsigned epoch, mask; int calibration; bool ready, sampling; } ConverterState;

Converter *converterCreate(unsigned epoch, const ConverterSettings *settings, const ConverterProfile *profile);
void converterDestroy(Converter *c);
void converterPilots(Converter *c, float *stereo, unsigned frames);
void converterInput(Converter *c, const float *mono, unsigned frames);
void converterSpeaker(Converter *c, float *mono, unsigned frames);
void converterContacts(Converter *c, unsigned mask);
void converterConfigure(Converter *c, const ConverterSettings *settings);
void converterMute(Converter *c, bool muted);
void converterInterrupt(Converter *c);
void converterCalibrate(Converter *c);
void converterSample(Converter *c, bool boosted);
void converterEndCalibration(Converter *c, bool automatic);
ConverterState converterState(Converter *c);
ConverterProfile converterProfile(Converter *c);
bool converterEdge(Converter *c, ConverterEdge *edge);
void converterTarget(Converter *c, uint32_t pid);
bool converterCharacter(Converter *c, uint32_t *pid, char *character, bool *space);
#ifdef __cplusplus
}
#endif
