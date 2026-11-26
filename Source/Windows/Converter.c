#include "Converter.h"
#include "../PaddleDSP.h"

enum { Rate = 48000 };
struct Converter {
    Generator generator;
    Detector detector;
    Keyer keyer;
    AtomicToneSettings tone;
    SidetoneLevel volume;
    ElementStream stream;
    TypingQueue typing;
    atomic_bool reverse;
    bool usbSwapped;
    unsigned usbMask;
    PaddleCalibrationStep calibration;
};

static void calibrationChanged(void *context, PaddleCalibrationStep step, bool sampling,
                               bool boosted, const InputProfile *profile) {
    Converter *c=context;
    (void)sampling; (void)boosted; (void)profile;
    c->calibration=step;
    c->generator.boosted=c->detector.step!=InputInactive ? c->detector.trialBoost : c->detector.profile.boosted;
}
Converter *converterCreate(unsigned epoch, const ConverterSettings *settings, const ConverterProfile *profile) {
    Converter *c=calloc(1,sizeof(*c));
    if (!c) return NULL;
    makeTables(Rate);
    configureKeyer(&c->keyer,Rate,settings->wpm);
    atomic_init(&c->stream.read,0); atomic_init(&c->stream.write,0); atomic_init(&c->stream.epoch,epoch);
    atomic_init(&c->tone,defaultToneSettings); atomic_init(&c->reverse,false);
    atomic_init(&c->volume.muted,false); atomic_init(&c->volume.percent,settings->volume);
    initTypingQueue(&c->typing);
    c->keyer.settings=&c->tone; c->keyer.volume=&c->volume; c->keyer.stream=&c->stream; c->keyer.typing=&c->typing;
    c->detector.keyer=&c->keyer; c->detector.swapRequested=&c->reverse; c->detector.waitForRelease=true;
    c->detector.captureChanged=calibrationChanged; c->detector.context=c;
    if (profile) {
        memcpy(c->detector.profile.on,profile->on,sizeof(profile->on));
        memcpy(c->detector.profile.off,profile->off,sizeof(profile->off));
        c->generator.boosted=c->detector.profile.boosted=profile->boosted;
    }
    converterConfigure(c,settings);
    return c;
}
void converterDestroy(Converter *c) { free(c); }
void converterPilots(Converter *c, float *stereo, unsigned frames) { tones(&c->generator,stereo,frames,Rate); }
void converterInput(Converter *c, const float *mono, unsigned frames) { acceptInput(&c->detector,NULL,mono,frames); }
void converterSpeaker(Converter *c, float *mono, unsigned frames) {
    renderKeyer(&c->keyer,frames,mono); applySidetoneVolume(&c->keyer,mono,frames);
}
void converterContacts(Converter *c, unsigned mask) {
    if (!c->usbMask) c->usbSwapped=atomic_load(&c->reverse);
    c->usbMask=mask;
    setPaddles(&c->keyer,c->usbSwapped ? ((mask&1)<<1)|((mask&2)>>1) : mask);
}
void converterConfigure(Converter *c, const ConverterSettings *s) {
    ToneSettings tone={.pitchHz=(uint16_t)s->pitch,.wpm=(uint8_t)s->wpm,.spacingWpm=(uint8_t)s->spacing,
        .riseMs=(uint8_t)s->rise,.fallMs=(uint8_t)s->fall,.curve=(uint8_t)s->curve,
        .options=(uint8_t)(TrainerGapThresholds | (s->spacing<s->wpm ? UseFarnsworth : 0) |
                           (s->modeB ? IambicModeB : 0) | (s->spaces ? TimedWordSpaces : 0))};
    atomic_store(&c->tone,tone); atomic_store(&c->volume.percent,s->volume); atomic_store(&c->reverse,s->reverse);
}
void converterMute(Converter *c, bool muted) { atomic_store(&c->volume.muted,muted); }
void converterInterrupt(Converter *c) {
    interruptElements(&c->stream); resetTypingSession(&c->typing);
    resetContactEvidence(&c->detector); c->detector.waitForRelease=true;
    c->usbMask=0;
}
void converterCalibrate(Converter *c) { beginCapture(&c->detector); }
void converterSample(Converter *c, bool boosted) { samplePosition(&c->detector,boosted); }
void converterEndCalibration(Converter *c, bool automatic) {
    if (automatic) c->detector.profile=(InputProfile){0};
    endCapture(&c->detector); c->calibration=InputInactive; c->generator.boosted=c->detector.profile.boosted;
}
ConverterState converterState(Converter *c) {
    Detector *d=&c->detector;
    return (ConverterState){atomic_load(&c->stream.epoch),logicalContacts(d),c->calibration,
        d->calibrated>=SettleBlocks+IdleBlocks && !d->waitForRelease && d->step==InputInactive,d->sampling};
}
ConverterProfile converterProfile(Converter *c) {
    InputProfile *p=&c->detector.profile;
    return (ConverterProfile){{p->on[0],p->on[1]},{p->off[0],p->off[1]},p->boosted};
}
bool converterEdge(Converter *c, ConverterEdge *out) {
    ElementEvent e; if (!takeElement(&c->stream,&e)) return false;
    *out=(ConverterEdge){e.frame,e.rate,e.epoch,e.kind}; return true;
}
void converterTarget(Converter *c, uint32_t pid) { selectTypingDestination(&c->typing,pid); }
bool converterCharacter(Converter *c, uint32_t *pid, char *character, bool *space) {
    TypedCharacter item; if (!takeTypedCharacter(&c->typing,&item)) return false;
    *pid=(uint32_t)item.destination; *character=item.character; *space=item.spaceBefore; return true;
}
