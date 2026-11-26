#pragma once
#include "PaddleCalibration.h"
#include "Sidetone.h"
#include "MorseTyping.h"
#include "ElementStream.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifndef MIN
#define MIN(a,b) ((a) < (b) ? (a) : (b))
#endif
#ifndef MAX
#define MAX(a,b) ((a) > (b) ? (a) : (b))
#endif

// The detector tables belong to one active capture route per process.
// Initialize them after stopping the old stream and before starting the new one.

enum { MaxBlock = 3840, QueueBuffers = 6, IdleBlocks = 100, SettleBlocks = 35 };
static const double toneHz[2] = {1000, 1600};

typedef struct { double phase[2], gain; bool boosted; } Generator;
static void tones(Generator *g, float *stereo, uint32_t frames, double hz) {
    double increment[2] = {2*M_PI*toneHz[0]/hz, 2*M_PI*toneHz[1]/hz};
    double step=.25/fmax(1,lround(hz*.01)), target=g->boosted ? .5 : .25;
    for (uint32_t i=0; i<frames; ++i) {
        g->gain+=fmax(-step,fmin(step,target-g->gain));
        for (int k=0; k<2; ++k) {
            *stereo++ = (float)(g->gain*sin(g->phase[k]));
            g->phase[k] += increment[k];
            if (g->phase[k] >= 2*M_PI) g->phase[k] -= 2*M_PI;
        }
    }
}
// Use 10 ms windows. Neighbouring bins reject taps and broad-band noise per tone.
typedef struct { double real, imag; } PilotPhase;
static uint32_t inputFrames;
static double window[MaxBlock], coeff[6], pilotSine[2];
static PilotPhase blockAdvance[2];
// Fit the two known return tones to a short slice. Around its midpoint the
// sine terms are odd and the cosine terms are even. Two 2×2 systems separate
// the paddles even when a slice contains a fractional number of pilot cycles.
enum { SlicesPerWindow=4 };
typedef struct { double a, cross, b; } PairMatrix;
typedef struct {
    uint32_t count;
    double basis[(MaxBlock+SlicesPerWindow-1)/SlicesPerWindow][4];
    PairMatrix cosine, sine;
} PilotSlicePlan;
typedef struct {
    PilotPhase tone[2];
    double power[2], residual;
} PilotSlice;
static PilotSlicePlan slicePlan[SlicesPerWindow];
static uint32_t sliceEnd[SlicesPerWindow];
static PilotPhase sliceAdvance[SlicesPerWindow][2];
static PairMatrix inversePair(PairMatrix m) {
    double determinant=m.a*m.b-m.cross*m.cross;
    return (PairMatrix){m.b/determinant,-m.cross/determinant,m.a/determinant};
}
static void prepareSlice(PilotSlicePlan *plan, uint32_t count, double hz) {
    plan->count=count;
    PairMatrix cosine={0}, sine={0};
    for (uint32_t i=0;i<count;i++) {
        double t=(i-(count-1)*.5)*2*M_PI/hz;
        double *v=plan->basis[i];
        v[0]=cos(t*toneHz[0]); v[1]=cos(t*toneHz[1]);
        v[2]=sin(t*toneHz[0]); v[3]=sin(t*toneHz[1]);
        cosine.a+=v[0]*v[0]; cosine.cross+=v[0]*v[1]; cosine.b+=v[1]*v[1];
        sine.a+=v[2]*v[2]; sine.cross+=v[2]*v[3]; sine.b+=v[3]*v[3];
    }
    plan->cosine=inversePair(cosine); plan->sine=inversePair(sine);
}
static PilotSlice fitSlice(const PilotSlicePlan *plan, const float *samples) {
    double dot[4]={0}, energy=0;
    for (uint32_t i=0;i<plan->count;i++) {
        double x=samples[i]; energy+=x*x;
        for (int j=0;j<4;j++) dot[j]+=x*plan->basis[i][j];
    }
    PairMatrix c=plan->cosine, s=plan->sine;
    PilotSlice fit={.tone={
        {c.a*dot[0]+c.cross*dot[1], -(s.a*dot[2]+s.cross*dot[3])},
        {c.cross*dot[0]+c.b*dot[1], -(s.cross*dot[2]+s.b*dot[3])}
    }};
    for (int k=0;k<2;k++) {
        PilotPhase p=fit.tone[k];
        fit.power[k]=p.real*p.real+p.imag*p.imag;
        // Subtract the energy explained by the two fitted pilot components.
        energy-=p.real*dot[k]-p.imag*dot[k+2];
    }
    fit.residual=isfinite(energy) ? fmax(0,energy)/plan->count : INFINITY;
    return fit;
}
static void makeTables(double hz) {
    inputFrames = (uint32_t)lround(hz*.01);
    for (unsigned i=0;i<SlicesPerWindow;i++) {
        sliceEnd[i]=(i+1)*inputFrames/SlicesPerWindow;
        prepareSlice(&slicePlan[i],sliceEnd[i]-i*inputFrames/SlicesPerWindow,hz);
    }
    const int bins[6] = {1000, 1600, 800, 1200, 1400, 1800};
    for (int k=0; k<6; ++k) coeff[k] = 2*cos(2*M_PI*bins[k]/hz);
    for (int k=0; k<2; ++k) {
        double w=2*M_PI*toneHz[k]/hz;
        pilotSine[k]=sin(w);
        for (unsigned i=0;i<SlicesPerWindow;i++) {
            unsigned previous=(i+SlicesPerWindow-1)%SlicesPerWindow;
            double hop=w*.5*(slicePlan[previous].count+slicePlan[i].count);
            sliceAdvance[i][k]=(PilotPhase){cos(hop),sin(hop)};
        }
        blockAdvance[k]=(PilotPhase){cos(w*inputFrames),sin(w*inputFrames)};
    }
    for (uint32_t i=0; i<inputFrames; ++i) window[i] = .5-.5*cos(2*M_PI*i/inputFrames);
}
static void measurePilots(const float *samples, double amp[6], PilotPhase phase[2]) {
    double prev[6]={0}, prev2[6]={0};
    for (uint32_t i=0; i<inputFrames; ++i) {
        double x = samples[i]*window[i];
        for (int k=0; k<6; ++k) {
            double s = x + coeff[k]*prev[k] - prev2[k];
            prev2[k] = prev[k]; prev[k] = s;
        }
    }
    for (int k=0; k<6; ++k) {
        double magnitude=sqrt(fmax(0,prev[k]*prev[k]+prev2[k]*prev2[k]-coeff[k]*prev[k]*prev2[k]));
        amp[k]=4.0/inputFrames*magnitude;
        if (k<2) phase[k]=magnitude>0 ? (PilotPhase){
            (prev[k]-.5*coeff[k]*prev2[k])/magnitude,pilotSine[k]*prev2[k]/magnitude
        } : (PilotPhase){0};
    }
}
static int ascending(const void *a, const void *b) {
    double x=*(const double *)a, y=*(const double *)b;
    return (x>y)-(x<y);
}

typedef struct {
    atomic_uint percent;
    atomic_bool muted;
} SidetoneLevel;

typedef struct {
    // Preserve the order of input transitions between speaker callbacks.
    atomic_uint read, write, mask;
    atomic_bool overrun;
    unsigned transitions[64];
} ContactQueue;

static void initContacts(ContactQueue *q) {
    atomic_init(&q->read,0); atomic_init(&q->write,0);
    atomic_init(&q->mask,0); atomic_init(&q->overrun,false);
}

typedef struct {
    ContactQueue wiredContacts;
    ContactQueue *contacts;
    unsigned held, pending, first, last;
    bool squeezed, waitNeutral, haveStamp;
    double nextSampleTime;
    ElementStream *stream;
    unsigned epoch;
    uint64_t nextWatermark;
    uint32_t markLength, markLeft, gapLeft;
    double rate, unitFrames, carry, phase, phaseStep;
    const AtomicToneSettings *settings;
    ToneSettings initialSettings;
    ToneRamps ramps;
    TypingQueue *typing;
    TypingDecoder decoder;
    uint64_t frame;
    const SidetoneLevel *volume;
    uint32_t volumeRamp;
    float volumeGain;
} Keyer;

static void configureKeyer(Keyer *k, double rate, double wpm) {
    initContacts(&k->wiredContacts);
    k->contacts=&k->wiredContacts;
    k->rate=rate; k->unitFrames=rate*1.2/wpm;
    k->initialSettings=defaultToneSettings; k->initialSettings.wpm=(uint8_t)wpm;
    k->volumeRamp=(uint32_t)MAX(1,lround(rate*.005));
    k->volumeGain=1;
}
static void queueContacts(ContactQueue *q, unsigned held) {
    if (atomic_exchange_explicit(&q->mask,held,memory_order_relaxed)==held) return;
    unsigned write=atomic_load_explicit(&q->write,memory_order_relaxed);
    if (write-atomic_load_explicit(&q->read,memory_order_acquire)>=64) {
        atomic_store(&q->overrun,true);
        return;
    }
    q->transitions[write%64]=held;
    atomic_store_explicit(&q->write,write+1,memory_order_release);
}
static void setPaddles(Keyer *k, unsigned held) { queueContacts(k->contacts,held); }

static void consumeContacts(Keyer *k) {
    ContactQueue *q=k->contacts;
    unsigned read=atomic_load_explicit(&q->read,memory_order_relaxed);
    unsigned write=atomic_load_explicit(&q->write,memory_order_acquire);
    if (atomic_exchange(&q->overrun,false)) {
        interruptElements(k->stream);
        k->waitNeutral=true;
    }
    unsigned epoch=k->stream ? atomic_load(&k->stream->epoch) : 0;
    if (k->epoch!=epoch || k->waitNeutral) {
        if (k->epoch!=epoch) {
            k->epoch=epoch; k->waitNeutral=true;
            if (k->typing) resetTypingSession(k->typing);
        }
        k->first=k->last=k->pending=k->markLeft=k->gapLeft=0;
        k->held=atomic_load(&q->mask);
        k->squeezed=false;
        k->waitNeutral=k->held!=0;
        read=write;
    }
    while (read!=write) {
        unsigned held=q->transitions[read++%64];
        k->pending|=held & ~k->held;
        k->held=held;
        if (!k->first && !k->markLeft && !k->gapLeft && held) {
            k->first=held==3 ? (k->last==1 ? 2 : 1) : held;
            k->pending &= ~k->first;
        }
        if (held==3) k->squeezed=true;
        if (!held && k->squeezed) {
            ToneSettings t=k->settings ? atomic_load(k->settings) : k->initialSettings;
            unsigned last=k->first ? k->first : k->last;
            k->pending=(t.options & IambicModeB) && last ? (last==1 ? 2 : 1) : 0;
            k->squeezed=false;
        }
    }
    atomic_store_explicit(&q->read,read,memory_order_release);
}
static uint32_t timedFrames(Keyer *k, unsigned units) {
    double exact = units*k->unitFrames+k->carry;
    uint32_t n = (uint32_t)lround(exact);
    k->carry = exact-n;
    return n;
}
static float nextKeyerSample(Keyer *k, uint64_t frame, bool sound) {
    if (k->gapLeft) { --k->gapLeft; return 0; }
    if (!k->markLeft) {
        unsigned requested = k->first ? k->first : (k->held | k->pending);
        k->first=0;
        if (!requested) { k->last=0; return 0; }
        k->last = requested==3 ? (k->last==1 ? 2 : 1) : requested;
        k->pending &= ~k->last;
        ToneSettings tone=k->settings ? atomic_load_explicit(k->settings,memory_order_relaxed) : k->initialSettings;
        double unit=k->rate*1.2/tone.wpm;
        if (k->unitFrames!=unit) { k->unitFrames=unit; k->carry=0; }
        k->markLength = k->markLeft = timedFrames(k,k->last==1 ? 1 : 3);
        emitElement(k->stream,k->epoch,1,frame,k->rate);
        if (sound) {
            k->phaseStep=2*M_PI*tone.pitchHz/k->rate;
            k->ramps=fitToneRamps(tone,k->rate,k->markLength);
        }
        if (k->decoder.armed) {
            double spacing=k->rate*spacingUnitMs(tone)/1000;
            bool trainer=(tone.options & TrainerGapThresholds)!=0;
            typeMark(&k->decoder,k->typing,k->last,frame,k->markLength,
                     trainer ? 2*unit : 3*spacing,(trainer ? 5 : 7)*spacing,(tone.options & TimedWordSpaces)!=0);
        }
        k->phase = 0;
    }
    float sample=0;
    if (sound) {
        uint32_t position = k->markLength-k->markLeft;
        double gain=toneEnvelopeGain(&k->ramps,position);
        sample = (float)(.2*gain*sin(k->phase));
        k->phase += k->phaseStep;
        if (k->phase >= 2*M_PI) k->phase -= 2*M_PI;
    }
    if (--k->markLeft==0) {
        k->gapLeft=timedFrames(k,1);
        emitElement(k->stream,k->epoch,2,frame+1,k->rate);
    }
    return sample;
}
static bool renderKeyer(Keyer *k, uint32_t frames, float *output) {
    consumeContacts(k);
    bool silent = k->waitNeutral || (!k->first && !k->held && !k->pending && !k->markLeft && !k->gapLeft);
    if (k->typing) prepareTypingBlock(&k->decoder,k->typing,silent && !k->waitNeutral);
    if (silent) {
        if (output) memset(output,0,(size_t)frames*sizeof(float));
        k->last=0;
    } else if (output) {
        for (uint32_t i=0; i<frames; ++i) output[i]=nextKeyerSample(k,k->frame+i,true);
    } else {
        for (uint32_t i=0; i<frames; ++i) nextKeyerSample(k,k->frame+i,false);
    }
    k->frame+=frames;
    if (silent && !k->waitNeutral && k->frame>=k->nextWatermark) {
        emitElement(k->stream,k->epoch,0,k->frame,k->rate);
        k->nextWatermark=k->frame+(uint64_t)(k->rate*.04);
    }
    if (k->decoder.armed) advanceTyping(&k->decoder,k->typing,k->frame);
    return silent;
}
static float levelGain(const SidetoneLevel *volume) {
    if (atomic_load_explicit(&volume->muted,memory_order_relaxed)) return 0;
    float fraction=(float)atomic_load_explicit(&volume->percent,memory_order_relaxed)/100;
    return fraction*fraction;
}
// Scale only the PCM destined for the sidetone device, before duplicating it to stereo.
static bool applySidetoneVolume(Keyer *k, float *samples, uint32_t frames) {
    if (!k->volume || !frames) return false;
    float gain=k->volumeGain, target=levelGain(k->volume);
    if (gain==1 && target==1) return false;
    uint32_t ramp=gain==target ? 0 : MIN(frames,k->volumeRamp);
    if (ramp) {
        float step=(target-gain)/ramp;
        for (uint32_t i=0; i<ramp; ++i) { gain+=step; samples[i]*=gain; }
        k->volumeGain=target;
    }
    if (!target) memset(samples+ramp,0,(frames-ramp)*sizeof(float));
    else if (target!=1) for (uint32_t i=ramp; i<frames; ++i) samples[i]*=target;
    return !target && !ramp;
}

typedef void (*ContactCallback)(void *, unsigned, bool);
enum { CaptureSettle=25, CaptureBlocks=150 };
typedef struct { double on[2], off[2]; bool boosted; } InputProfile;
typedef struct { double low[2], high[2]; } InputRange;
typedef void (*CaptureCallback)(void *, PaddleCalibrationStep, bool, bool, const InputProfile *);
typedef struct {
    int calibrated, stable, repeats[2], neutralFrames;
    bool carrier[2], waitForRelease;
    PilotPhase expected[2];
    float input[MaxBlock];
    uint32_t filled, sliceIndex;
    unsigned cleanPairs[2];
    PilotSlice previousSlice;
    bool havePreviousSlice;
    const atomic_bool *swapRequested;
    bool swappedForPress;
    Keyer *keyer;
    double idle[2][IdleBlocks], on[2], off[2], idleLevel[2], quietPeak[2];
    unsigned quietBlocks[2];
    InputProfile profile;
    PaddleCalibrationStep step;
    bool sampling, trialBoost;
    int captureFrame;
    InputRange measurements[4];
    double capture[2][CaptureBlocks];
    ContactCallback change;
    CaptureCallback captureChanged;
    void *context;
} Detector;
static void resetContactEvidence(Detector *d) {
    d->stable=0; d->neutralFrames=0; d->filled=d->sliceIndex=0; d->havePreviousSlice=false;
    memset(d->carrier,0,sizeof(d->carrier)); memset(d->repeats,0,sizeof(d->repeats));
    if (d->keyer) setPaddles(d->keyer,0);
}
static void notifyCapture(Detector *d, PaddleCalibrationStep step) {
    if (d->captureChanged) d->captureChanged(d->context,step,d->sampling,d->trialBoost,
                                             step==InputCalibrated ? &d->profile : NULL);
}
static void beginCapture(Detector *d) {
    resetContactEvidence(d); d->waitForRelease=true; d->step=InputReleased;
    d->sampling=false; d->trialBoost=d->profile.boosted;
    notifyCapture(d,d->step);
}
static void samplePosition(Detector *d, bool boosted) {
    if (d->step<InputReleased || d->step>InputBoth || d->sampling) return;
    if (d->step==InputReleased) d->trialBoost=boosted;
    d->sampling=true; d->captureFrame=-CaptureSettle;
    notifyCapture(d,d->step);
}
static void endCapture(Detector *d) {
    d->sampling=false; d->step=InputInactive; d->trialBoost=d->profile.boosted;
    resetContactEvidence(d); d->waitForRelease=true;
}
// Either physical side can be measured first. Each tone must be distinct from
// movement and from the other paddle alone, and must still be present in a squeeze.
static bool fitInputProfile(const InputRange samples[4], bool boosted, InputProfile *out) {
    for (int first=0;first<2;++first) {
        InputProfile profile={.boosted=boosted};
        for (int k=0;k<2;++k) {
            int own=k==first ? 1 : 2;
            double quiet=fmax(samples[0].high[k],samples[3-own].high[k]);
            double keyed=fmin(samples[own].low[k],samples[3].low[k]);
            if (!isfinite(keyed) || !isfinite(quiet) || keyed<fmax(.00008,quiet*1.5+.00002)) break;
            double span=keyed-quiet;
            profile.on[k]=quiet+.55*span;
            profile.off[k]=quiet+.30*span;
        }
        if (profile.on[0] && profile.on[1]) { *out=profile; return true; }
    }
    return false;
}
static void captureWindow(Detector *d, const double a[6]) {
    if (!d->sampling) return;
    int frame=d->captureFrame++;
    if (frame<0) return;
    for (int k=0;k<2;++k) {
        double guard=fmax(a[2+2*k],a[3+2*k]);
        d->capture[k][frame]=a[k]>1.6*guard ? a[k] : 0;
    }
    if (d->captureFrame<CaptureBlocks) return;
    InputRange *range=&d->measurements[d->step-InputReleased];
    for (int k=0;k<2;++k) {
        // An isolated spike cannot qualify as a press. Include the strongest
        // level sustained across two adjacent windows in the released reading.
        double high=0;
        for (int i=1;i<CaptureBlocks;++i) high=fmax(high,fmin(d->capture[k][i-1],d->capture[k][i]));
        qsort(d->capture[k],CaptureBlocks,sizeof(double),ascending);
        range->high[k]=high; range->low[k]=d->capture[k][CaptureBlocks/10];
    }
    d->sampling=false;
    if (d->step!=InputBoth) { ++d->step; notifyCapture(d,d->step); return; }
    bool success=fitInputProfile(d->measurements,d->trialBoost,&d->profile);
    endCapture(d);
    notifyCapture(d,success ? InputCalibrated : InputOverlap);
}
static unsigned logicalContacts(const Detector *d) {
    unsigned physical=(unsigned)d->stable;
    return d->swappedForPress ? ((physical & 1u)<<1) | ((physical & 2u)>>1) : physical;
}
static void commitContacts(Detector *d, int bits) {
    if (d->stable==bits) return;
    if (!d->stable && d->swapRequested)
        d->swappedForPress=atomic_load_explicit(d->swapRequested,memory_order_relaxed);
    for (int k=0;k<2;k++) if ((d->stable^bits)&(1<<k)) {
        d->repeats[k]=0; d->cleanPairs[k]=0;
    }
    d->stable=bits;
    unsigned mask=logicalContacts(d);
    if (d->keyer) setPaddles(d->keyer,mask);
    if (d->change) d->change(d->context,mask,d->swappedForPress);
}
static void setIdleLevel(Detector *d, int k, double level) {
    d->idleLevel[k]=level;
    d->on[k]=fmax(.00008,level*2.3+.00003);
    d->off[k]=fmax(.000045,level*1.6+.000015);
}
static void detectWindow(Detector *d, const float *samples, int cleanBits) {
    double a[6]; PilotPhase phase[2]; measurePilots(samples,a,phase);
    if (d->step!=InputInactive) { captureWindow(d,a); return; }
    if (d->calibrated < SettleBlocks + IdleBlocks) {
        int index = d->calibrated++ - SettleBlocks;
        if (index < 0) return;
        for (int k=0; k<2; ++k) d->idle[k][index] = a[k];
        if (index == IdleBlocks-1) {
            for (int k=0; k<2; ++k) {
                qsort(d->idle[k], IdleBlocks, sizeof(double), ascending);
                setIdleLevel(d,k,d->idle[k][(IdleBlocks*90)/100]);
            }
            if (d->change && !d->waitForRelease) d->change(d->context,0,false);
        }
        return;
    }
    int bits=d->stable;
    bool neutral=true;
    for (int k=0; k<2; ++k) {
        int bit=1<<k;
        bool down=(d->stable&bit)!=0;
        // Recover a startup noise floor accidentally measured with a paddle held.
        if (!d->profile.on[k] && !down && a[k]<d->idleLevel[k]*.25) {
            d->quietPeak[k]=fmax(d->quietPeak[k],a[k]);
            if (++d->quietBlocks[k]==25) {
                setIdleLevel(d,k,d->quietPeak[k]); d->quietBlocks[k]=0; d->quietPeak[k]=0;
            }
        } else { d->quietBlocks[k]=0; d->quietPeak[k]=0; }
        double on=d->profile.on[k] ? d->profile.on[k] : d->on[k];
        double off=d->profile.off[k] ? d->profile.off[k] : d->off[k];
        double guards=fmax(a[2+2*k],a[3+2*k]);
        bool aboveRelease=a[k]>off && a[k]>1.6*guards;
        bool present=down ? aboveRelease : a[k]>on && a[k]>2.1*guards;
        bool coherent=!d->carrier[k] ||
            phase[k].real*d->expected[k].real+phase[k].imag*d->expected[k].imag>=M_SQRT1_2;
        PilotPhase shift=blockAdvance[k];
        d->expected[k]=(PilotPhase){phase[k].real*shift.real-phase[k].imag*shift.imag,
                                    phase[k].real*shift.imag+phase[k].imag*shift.real};
        d->carrier[k]=present;
        if (aboveRelease && coherent) neutral=false;
        if (d->waitForRelease) continue;
        if (!down && present && !coherent) d->repeats[k]=1;
        else if ((present && coherent)==down) d->repeats[k]=0;
        else if (++d->repeats[k]>=2) { bits^=bit; d->repeats[k]=0; }
    }
    if (d->waitForRelease) {
        d->neutralFrames=neutral ? d->neutralFrames+1 : 0;
        if (d->neutralFrames>=2) {
            d->waitForRelease=false;
            if (d->change) d->change(d->context,0,false);
        }
        return;
    }
    // Publish one contact snapshot when both analyses finish on the same sample.
    // Separate snapshots here could create an iambic squeeze that never happened.
    int cleanChanges=cleanBits^d->stable;
    commitContacts(d,(bits & ~cleanChanges) | (cleanBits & cleanChanges));
}

// Three consecutive disjoint, consistent slices can establish a transition. Marginal
// levels, frequency drift or energy outside the pilot model leave it to the
// existing 10 ms spectral/phase detector and its per-contact hysteresis.
static int cleanContacts(Detector *d, PilotSlice current) {
    int bits=d->stable;
    if (d->havePreviousSlice) {
        const PilotSlice *before=&d->previousSlice;
        for (int k=0;k<2;k++) {
            int bit=1<<k;
            double low=fmin(before->power[k],current.power[k]);
            double high=fmax(before->power[k],current.power[k]);
            double noise=fmax(before->residual,current.residual);
            bool consistent;
            if (bits & bit) {
                double off=d->profile.off[k] ? d->profile.off[k] : d->off[k];
                double quiet=.8*off;
                consistent=high<quiet*quiet && noise<.125*off*off;
            } else {
                double on=d->profile.on[k] ? d->profile.on[k] : d->on[k];
                // Require 30% level headroom, agreement within 3 dB, and little
                // unexplained energy relative to this particular paddle.
                double strong=1.3*on;
                PilotPhase a=before->tone[k], b=current.tone[k], shift=sliceAdvance[d->sliceIndex][k];
                double agreement=(a.real*shift.real-a.imag*shift.imag)*b.real +
                                 (a.real*shift.imag+a.imag*shift.real)*b.imag;
                const double minimumCosine=cos(M_PI/24); // 7.5° over approximately 2.5 ms
                consistent=low>strong*strong && low>=.5*high && noise<=.015*low &&
                    agreement>0 && agreement*agreement>=minimumCosine*minimumCosine*low*high;
            }
            if (!consistent) d->cleanPairs[k]=0;
            else if (++d->cleanPairs[k]>=2) bits^=bit;
        }
    } else d->cleanPairs[0]=d->cleanPairs[1]=0;
    d->previousSlice=current; d->havePreviousSlice=true;
    return bits;
}
static void acceptInput(Detector *d, Keyer *quiet, const float *src, uint32_t count) {
    while (count) {
        const PilotSlicePlan *plan=&slicePlan[d->sliceIndex];
        uint32_t end=sliceEnd[d->sliceIndex];
        uint32_t n=MIN(end-d->filled,count);
        memcpy(d->input+d->filled,src,n*sizeof(*src));
        d->filled+=n; src+=n; count-=n;
        if (d->filled!=end) continue;
        if (quiet && !d->keyer && d->calibrated>=SettleBlocks+IdleBlocks) {
            setPaddles(quiet,logicalContacts(d)); renderKeyer(quiet,plan->count,NULL);
        }
        int clean=d->stable;
        if (!d->step && !d->waitForRelease && d->calibrated>=SettleBlocks+IdleBlocks)
            clean=cleanContacts(d,fitSlice(plan,d->input+end-plan->count));
        else d->havePreviousSlice=false;
        if (++d->sliceIndex==SlicesPerWindow) {
            d->filled=d->sliceIndex=0;
            detectWindow(d,d->input,clean);
        } else commitContacts(d,clean);
    }
}
