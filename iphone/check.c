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
int main(void) {
    const unsigned rates[] = {44100, 48000};
    for (unsigned i = 0; i < 2; ++i)
        for (unsigned side = 0; side < 4; ++side)
            if (scenario(rates[i], side, true) || scenario(rates[i], side, false)) return EXIT_FAILURE;
    puts("Simulated released, left, right and both passed at 44.1 and 48 kHz in both modes.");
    puts("Speaker PCM matched scoring edges. Contacts-only produced zero speaker frames and zero scoring marks.");
    return EXIT_SUCCESS;
}
