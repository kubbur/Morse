#include "Sidetone.h"
#include <math.h>

const ToneSettings defaultToneSettings={.pitchHz=650,.wpm=30,.riseMs=2,.fallMs=2,.curve=RaisedCosine,.spacingWpm=12};

unsigned effectiveWPM(ToneSettings t) {
    return (t.options & UseFarnsworth) && t.spacingWpm && t.spacingWpm<t.wpm ? t.spacingWpm : t.wpm;
}
double spacingUnitMs(ToneSettings t) {
    unsigned effective=effectiveWPM(t);
    double dit=1200.0/t.wpm;
    // PARIS has 31 fixed element units and 19 spacing units per word.
    return effective==t.wpm ? dit : (60000.0/effective-31*dit)/19;
}

ToneRamps fitToneRamps(ToneSettings settings, double rate, uint32_t frames) {
    uint32_t last=frames ? frames-1 : 0;
    uint32_t rise=(uint32_t)lround(rate*settings.riseMs/1000);
    uint32_t fall=(uint32_t)lround(rate*settings.fallMs/1000);
    if (rise+fall>last) {
        rise=(uint32_t)lround((double)last*rise/(rise+fall));
        fall=last-rise;
    }
    return (ToneRamps){rise,fall,last,(RampCurve)settings.curve};
}
double toneEnvelopeGain(const ToneRamps *r, uint32_t frame) {
    if (frame>r->last) return 0;
    double x;
    if (frame<r->rise) x=(double)frame/r->rise;
    else if (r->last-frame<r->fall) x=(double)(r->last-frame)/r->fall;
    else return 1;
    switch (r->curve) {
        case LinearRamp: return x;
        case ExponentialRamp: return expm1(3*x)/expm1(3.0);
        default: return .5-.5*cos(M_PI*x);
    }
}
