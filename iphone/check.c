// Synthetic electrical return from the release generator, checked against the
// real speaker PCM and scorer edges from the same core used on the phone.
#include "Core.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static int scenario(unsigned rate, unsigned side, bool withSpeaker) {
    PhoneCore *core = phoneCreate(rate);
    if (!core) return 1;
    const unsigned block = 128;
    float pilots[256], mic[128], speaker[128] = {0};
    unsigned contacts = 0, starts = 0, stops = 0, failed = 0;
    bool open = false;
    uint64_t start = 0;
    unsigned dot = (unsigned)lround(rate * .040);
    for (unsigned frame = 0; frame < 3*rate; frame += block) {
        unsigned held = frame >= 2*rate && frame < 2*rate + rate/4 ? side : 0;
        phonePilots(core, pilots, block);
        for (unsigned i = 0; i < block; ++i)
            mic[i] = pilots[2*i] * (.0004f + ((held & 1) ? .029f : 0)) +
                     pilots[2*i+1] * (.0003f + ((held & 2) ? .012f : 0));
        phoneInput(core, mic, block);
        if (phoneReady(core)) contacts |= 1u << phoneMask(core);
        if (withSpeaker) phoneSpeaker(core, speaker, block);
        ElementEvent event;
        bool marked[128];
        for (unsigned i = 0; i < block; ++i) marked[i] = open;
        while (phoneEvent(core, &event)) {
            if (!event.kind) continue;
            if (event.kind == 1) {
                if (open) failed = 1;
                ++starts; start = event.frame; open = true;
            } else {
                unsigned length = (unsigned)(event.frame - start);
                if (!open || (length != dot && length != 3*dot)) failed = 1;
                if ((side == 1 && length != dot) || (side == 2 && length != 3*dot)) failed = 1;
                if (side == 3 && length != (stops % 2 ? 3*dot : dot)) failed = 1;
                ++stops; open = false;
            }
            for (unsigned i = 0; i < block; ++i) if (frame+i >= event.frame) marked[i] = open;
        }
        for (unsigned i = 0; i < block; ++i)
            if (!isfinite(speaker[i]) || (!marked[i] && fabsf(speaker[i]) > .00001f)) failed = 1;
    }
    bool expectMarks = side && withSpeaker;
    if (!(contacts & (1u << side)) || phoneMask(core) || !phoneReady(core) || starts != stops ||
        (expectMarks ? (!starts || !phoneAudibleFrames(core)) : (starts || phoneAudibleFrames(core))) ||
        (withSpeaker && side == 3 && starts < 2)) failed = 1;
    phoneDestroy(core);
    if (failed) fprintf(stderr, "Failed at %u Hz, contacts %u, speaker %d, starts %u, stops %u\n",
                        rate, side, withSpeaker, starts, stops);
    return failed;
}
static bool nearLevel(double actual, double expected) {
    return isfinite(actual) && fabs(actual-expected) < .0001;
}
static int meterScenario(unsigned rate, unsigned channels) {
    PhoneCore *core = phoneCreate(rate);
    if (!core) return 1;
    PhoneSignalMeter *meter = phoneMeterCreate(channels);
    if (!meter) { phoneDestroy(core); return 1; }
    const unsigned window = 25*(unsigned)lround(rate*.01);
    float source[254], pilots[254];
    PhoneSignalReading r;
    bool failed = false;
    for (unsigned phase=0; phase<3; ++phase) {
        unsigned length = phase == 2 ? 2*window : window;
        for (unsigned pos=0; pos<length;) {
            unsigned n = length-pos < 127 ? length-pos : 127;
            phonePilots(core,pilots,n);
            for (unsigned i=0; i<n; ++i) {
                double unrelated = .125*sin(2*M_PI*400*(pos+i)/rate);
                source[channels*i] = phase==0 ? unrelated : phase==1 ? 0 : .4f*pilots[2*i];
                if (channels==2) source[channels*i+1] = phase==2 ? -.4f*pilots[2*i]+.2f*pilots[2*i+1] : 0;
            }
            phoneMeterInput(meter,source,n,phase+1);
            pos+=n;
        }
        bool received = phoneMeterRead(meter,&r);
        if (phase==2 && received) received = phoneMeterRead(meter,&r);
        if (!received) { failed = true; break; }
        if (r.outputTag != phase+1 || r.ordinal != (phase==2 ? 2u : 1u) || r.frames != window) failed=true;
        PhoneSignalLevel a = r.channels[0], b = r.channels[1];
        double rms = phase==0 ? .125/sqrt(2) : phase==1 ? 0 : .1/sqrt(2);
        if (!nearLevel(a.rms,rms) || !nearLevel(a.tone[0],phase==2 ? .1 : 0) || !nearLevel(a.tone[1],0)) failed=true;
        if (phase==0 && !nearLevel(a.peak,.125)) failed=true;
        if (phase==1 && (a.peak || b.peak)) failed=true;
        if (channels==2 && (!nearLevel(b.rms,phase==2 ? sqrt((.1*.1+.05*.05)/2) : 0) ||
            !nearLevel(b.tone[0],phase==2 ? .1 : 0) || !nearLevel(b.tone[1],phase==2 ? .05 : 0))) failed=true;
        if (phoneMeterRead(meter,&r)) failed=true;
        // A partial buffer from the previous drive setting must never enter the next reading.
        for (unsigned i=0;i<17*channels;++i) source[i]=1;
        phoneMeterInput(meter,source,17,phase+1);
    }
    phoneMeterDestroy(meter); phoneDestroy(core);
    if (failed) fprintf(stderr,"Signal meter failed at %u Hz, %u input channels\n",rate,channels);
    return failed;
}
int main(void) {
    const unsigned rates[] = {44100, 48000};
    for (unsigned i = 0; i < 2; ++i) {
        if (meterScenario(rates[i],1) || meterScenario(rates[i],2)) return EXIT_FAILURE;
        for (unsigned side = 0; side < 4; ++side)
            if (scenario(rates[i], side, true) || scenario(rates[i], side, false)) return EXIT_FAILURE;
    }
    puts("Jack meter passed silence, off-frequency audio and independent stereo returns at both sample rates.");
    puts("Simulated released, left, right and both passed at 44.1 and 48 kHz in both modes.");
    puts("Speaker PCM matched scoring edges. Contacts-only produced zero speaker frames and zero scoring marks.");
    return EXIT_SUCCESS;
}
