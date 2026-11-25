#import <Foundation/Foundation.h>
#import "Core.h"
#import "MorseEngine.h"
#include "MorseTyping.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

// Generated from the supplied release. The hardware adapter and UI live in this kit.
#include "ReleaseDSP.inc"

struct PhoneCore {
    Generator generator;
    Keyer keyer;
    Detector detector;
    ElementStream stream;
    SidetoneLevel volume;
    AtomicToneSettings settings;
    atomic_bool reverse, ready;
    atomic_uint physical;
    _Atomic(uint64_t) audible;
};

// A route owns one core. Its three queues are disposed before another route initializes
// the release detector's sample-rate tables.
PhoneCore *phoneCreate(double rate) {
    if (!isfinite(rate) || rate < 8000 || rate > 384000) return NULL;
    PhoneCore *c = calloc(1, sizeof(*c));
    if (!c) return NULL;
    makeTables(rate);
    configureKeyer(&c->keyer, rate, defaultToneSettings.wpm);
    atomic_init(&c->settings, defaultToneSettings);
    atomic_init(&c->volume.percent, 65);
    c->keyer.settings = &c->settings;
    c->keyer.stream = &c->stream;
    c->keyer.volume = &c->volume;
    c->detector.keyer = &c->keyer;
    c->detector.swapRequested = &c->reverse;
    return c;
}
void phoneDestroy(PhoneCore *c) { free(c); }
void phonePilots(PhoneCore *c, float *stereo, unsigned frames) {
    tones(&c->generator, stereo, frames, c->keyer.rate);
}
void phoneInput(PhoneCore *c, const float *mono, unsigned frames) {
    acceptInput(&c->detector, NULL, mono, frames);
    atomic_store(&c->physical, (unsigned)c->detector.stable);
    atomic_store(&c->ready, c->detector.calibrated >= SettleBlocks + IdleBlocks && !c->detector.waitForRelease);
}
void phoneSpeaker(PhoneCore *c, float *mono, unsigned frames) {
    renderKeyer(&c->keyer, frames, mono);
    applySidetoneVolume(&c->keyer, mono, frames);
    unsigned audible = 0;
    for (unsigned i = 0; i < frames; ++i) if (fabsf(mono[i]) > .0001f) ++audible;
    if (audible) atomic_fetch_add(&c->audible, audible);
}
void phoneSound(PhoneCore *c, unsigned wpm, unsigned spacing, unsigned pitch,
                unsigned volume, unsigned rise, unsigned fall, unsigned curve, bool modeB) {
    ToneSettings setting = {.wpm=MAX(5,MIN(80,wpm)), .pitchHz=MAX(200,MIN(2000,pitch)),
        .riseMs=MAX(1,MIN(30,rise)), .fallMs=MAX(1,MIN(30,fall)), .curve=MIN(2,curve),
        .options=TrainerGapThresholds | (modeB ? IambicModeB : 0)};
    setting.spacingWpm = MAX(1,MIN(setting.wpm,spacing));
    if (setting.spacingWpm < setting.wpm) setting.options |= UseFarnsworth;
    ToneSettings prior = atomic_exchange(&c->settings, setting);
    if (memcmp(&prior, &setting, sizeof(setting))) phoneInvalidate(c);
    atomic_store(&c->volume.percent, MIN(100,volume));
}
void phoneMute(PhoneCore *c, bool muted) { atomic_store(&c->volume.muted, muted); }
void phoneReverse(PhoneCore *c, bool reverse) {
    if (atomic_exchange(&c->reverse, reverse) != reverse) phoneInvalidate(c);
}
void phoneInvalidate(PhoneCore *c) { interruptElements(&c->stream); }
bool phoneReady(PhoneCore *c) { return atomic_load(&c->ready); }
unsigned phoneMask(PhoneCore *c) { return atomic_load(&c->physical); }
unsigned phoneEpoch(PhoneCore *c) { return atomic_load(&c->stream.epoch); }
bool phoneEvent(PhoneCore *c, ElementEvent *event) { return takeElement(&c->stream, event); }
uint64_t phoneAudibleFrames(PhoneCore *c) { return atomic_load(&c->audible); }

enum { SignalWindows = 25, SignalCapacity = 16 };
struct PhoneSignalMeter {
    unsigned channels, filled, windows, tag, ordinal;
    uint64_t framesSeen;
    float samples[2][MaxBlock];
    PhoneSignalLevel totals[2];
    atomic_uint read, write;
    PhoneSignalReading readings[SignalCapacity];
};
PhoneSignalMeter *phoneMeterCreate(unsigned channels) {
    if (channels < 1 || channels > 2 || !inputFrames || inputFrames > MaxBlock) return NULL;
    PhoneSignalMeter *m = calloc(1, sizeof(*m));
    if (m) {
        m->channels = channels;
        atomic_init(&m->read,0); atomic_init(&m->write,0);
    }
    return m;
}
void phoneMeterDestroy(PhoneSignalMeter *m) { free(m); }

static void finishSignalWindow(PhoneSignalMeter *m) {
    for (unsigned ch=0; ch<m->channels; ++ch) {
        PhoneSignalLevel *sum = &m->totals[ch];
        double amplitudes[6]; PilotPhase phases[2];
        measurePilots(m->samples[ch],amplitudes,phases);
        for (unsigned i=0; i<inputFrames; ++i) {
            double x = m->samples[ch][i];
            sum->peak = fmax(sum->peak,fabs(x));
            sum->rms += x*x;
        }
        for (unsigned p=0; p<2; ++p) sum->tone[p] += amplitudes[p]*amplitudes[p];
    }
    m->filled = 0;
    if (++m->windows < SignalWindows) return;
    PhoneSignalReading value = {.outputTag=m->tag,.ordinal=++m->ordinal,.frames=SignalWindows*inputFrames,.endFrame=m->framesSeen};
    for (unsigned ch=0; ch<m->channels; ++ch) {
        PhoneSignalLevel sum = m->totals[ch];
        value.channels[ch].peak = sum.peak;
        value.channels[ch].rms = sqrt(sum.rms/value.frames);
        for (unsigned p=0; p<2; ++p) value.channels[ch].tone[p] = sqrt(sum.tone[p]/SignalWindows);
    }
    // A single audio callback publishes and the main thread drains this ring.
    unsigned write = atomic_load_explicit(&m->write,memory_order_relaxed);
    if (write-atomic_load_explicit(&m->read,memory_order_acquire) < SignalCapacity) {
        m->readings[write%SignalCapacity] = value;
        atomic_store_explicit(&m->write,write+1,memory_order_release);
    }
    m->windows = 0; memset(m->totals,0,sizeof(m->totals));
}
void phoneMeterInput(PhoneSignalMeter *m, const float *input, unsigned frames, unsigned tag) {
    if (m->tag != tag) {
        m->tag = tag; m->filled = m->windows = m->ordinal = 0;
        memset(m->totals,0,sizeof(m->totals));
    }
    while (frames) {
        unsigned take = MIN(frames,inputFrames-m->filled);
        for (unsigned i=0; i<take; ++i)
            for (unsigned ch=0; ch<m->channels; ++ch) {
                float x = *input++;
                m->samples[ch][m->filled+i] = isfinite(x) ? x : 0;
            }
        m->filled += take; m->framesSeen += take; frames -= take;
        if (m->filled == inputFrames) finishSignalWindow(m);
    }
}
bool phoneMeterRead(PhoneSignalMeter *m, PhoneSignalReading *result) {
    unsigned read = atomic_load_explicit(&m->read,memory_order_relaxed);
    if (read == atomic_load_explicit(&m->write,memory_order_acquire)) return false;
    *result = m->readings[read%SignalCapacity];
    atomic_store_explicit(&m->read,read+1,memory_order_release);
    return true;
}
