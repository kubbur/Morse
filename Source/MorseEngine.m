#import "MorseEngine.h"
#include "MorseTyping.h"
#include "PaddleClock.h"
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#include <CoreAudio/CoreAudio.h>
#include <AudioToolbox/AudioToolbox.h>
#include <AudioUnit/AudioUnit.h>
#include <math.h>
#include <limits.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum { MaxBlock = 3840, QueueBuffers = 6, IdleBlocks = 100, SettleBlocks = 35 };
static const double toneHz[2] = {1000, 1600};
static double monotonicSeconds(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec * 1e-9;
}
static void say(const char *format, ...) __attribute__((format(printf,1,2)));
static void say(const char *format, ...) {
    va_list args; va_start(args,format); vfprintf(stderr,format,args); va_end(args);
    fputc(10,stderr);
}
static bool checked(OSStatus status, const char *action) {
    if (status == noErr) return true;
    char code[5]; UInt32 word = (UInt32)status;
    for (int i = 0; i < 4; ++i) {
        unsigned c = (word >> (24 - 8*i)) & 255;
        code[i] = (c >= 32 && c <= 126) ? (char)c : '.';
    }
    code[4] = 0;
    say("%s failed (Core Audio %d, '%s').", action, (int)status, code);
    return false;
}

// Inspect the active connector of each built-in endpoint. A default device alone
// is insufficient evidence: it could be the speakers, internal mic or AirPods.
typedef struct {
    AudioDeviceID dev; UInt32 channels, transport, source;
    bool input, alive, disconnected, headsetTerminal, speakerTerminal;
    char name[256], uid[512], sourceName[256];
} Route;
static bool property(AudioObjectID id, AudioObjectPropertySelector sel, AudioObjectPropertyScope scope,
                     void *data, UInt32 size) {
    AudioObjectPropertyAddress address = {sel, scope, kAudioObjectPropertyElementMain};
    return AudioObjectGetPropertyData(id, &address, 0, NULL, &size, data) == noErr;
}
static void *propertyArray(AudioObjectID id, AudioObjectPropertySelector sel,
                           AudioObjectPropertyScope scope, UInt32 *size) {
    AudioObjectPropertyAddress address = {sel, scope, kAudioObjectPropertyElementMain};
    *size = 0;
    if (AudioObjectGetPropertyDataSize(id, &address, 0, NULL, size) || !*size) return NULL;
    void *items = calloc(1, *size);
    if (items && AudioObjectGetPropertyData(id, &address, 0, NULL, size, items) == noErr) return items;
    free(items); *size = 0; return NULL;
}
static void copyString(CFStringRef str, char *dest, size_t n) {
    if (str) {
        if (!CFStringGetCString(str, dest, n, kCFStringEncodingUTF8)) dest[0] = 0;
        CFRelease(str);
    }
}
static void objectString(AudioObjectID id, AudioObjectPropertySelector sel, char *dest, size_t n) {
    CFStringRef str = NULL;
    if (property(id, sel, kAudioObjectPropertyScopeGlobal, &str, sizeof(str))) copyString(str, dest, n);
}
static bool has(const char *s, const char *part) { return strcasestr(s, part) != NULL; }
static bool wired(const Route *r) {
    if (!r->alive || r->disconnected || !r->uid[0] || r->transport != kAudioDeviceTransportTypeBuiltIn ||
        r->channels < (r->input ? 1u : 2u)) return false;
    if (r->source == 'imic' || r->source == 'ispk' || r->source == 'spkr' || has(r->sourceName, "internal") ||
        has(r->sourceName, "speaker") || has(r->sourceName, "built-in mic")) return false;
    if (r->input) {
        return r->headsetTerminal || r->source == 'emic' || r->source == 'hmic' || r->source == 'hdst' ||
               has(r->sourceName, "external mic") || has(r->sourceName, "headset") ||
               has(r->uid, "headset") || has(r->uid, "headphoneinput") || has(r->uid, "headphonemic") ||
               has(r->uid, "externalmic") || has(r->name, "external mic") ||
               has(r->name, "headphone mic") || has(r->name, "headset mic");
    }
    return r->headsetTerminal || r->source == 'hdpn' || r->source == 'hdph' || r->source == 'hdst' ||
           has(r->sourceName, "headphone") || has(r->sourceName, "headset") ||
           has(r->uid, "headphone") || has(r->uid, "headset") ||
           has(r->name, "headphone") || has(r->name, "headset");
}
static bool builtInSpeaker(const Route *r) {
    if (r->input || !r->alive || !r->channels || !r->uid[0] ||
        r->transport != kAudioDeviceTransportTypeBuiltIn) return false;
    if (r->headsetTerminal || r->source == 'hdpn' || r->source == 'hdph' || r->source == 'hdst' ||
        has(r->sourceName,"headphone") || has(r->sourceName,"headset") ||
        has(r->uid,"headphone") || has(r->uid,"headset")) return false;
    return r->speakerTerminal || r->source == 'ispk' || r->source == 'spkr' ||
           has(r->uid,"BuiltInSpeaker") || has(r->name,"speaker") || has(r->sourceName,"speaker");
}
static Route inspect(AudioDeviceID dev, bool input) {
    Route r = {.dev=dev, .input=input};
    AudioObjectPropertyScope scope = input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput;
    UInt32 size = 0, alive = 1, jack = 1;
    AudioBufferList *config = propertyArray(dev, kAudioDevicePropertyStreamConfiguration, scope, &size);
    if (config) {
        for (UInt32 i=0; i<config->mNumberBuffers; ++i) r.channels += config->mBuffers[i].mNumberChannels;
        free(config);
    }
    if (!r.channels) return r;
    objectString(dev, kAudioObjectPropertyName, r.name, sizeof(r.name));
    objectString(dev, kAudioDevicePropertyDeviceUID, r.uid, sizeof(r.uid));
    property(dev, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, &r.transport, sizeof(r.transport));
    property(dev, kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal, &alive, sizeof(alive));
    r.alive = alive != 0;
    r.disconnected = property(dev, kAudioDevicePropertyJackIsConnected, scope, &jack, sizeof(jack)) && jack == 0;
    if (property(dev, kAudioDevicePropertyDataSource, scope, &r.source, sizeof(r.source))) {
        CFStringRef name = NULL;
        AudioValueTranslation value = {&r.source, sizeof(r.source), &name, sizeof(name)};
        if (property(dev, kAudioDevicePropertyDataSourceNameForIDCFString, scope, &value, sizeof(value)))
            copyString(name, r.sourceName, sizeof(r.sourceName));
    }
    AudioStreamID *streams = propertyArray(dev, kAudioDevicePropertyStreams, scope, &size);
    for (size_t i=0; streams && i<size/sizeof(*streams); ++i) {
        UInt32 terminal = 0;
        property(streams[i], kAudioStreamPropertyTerminalType, kAudioObjectPropertyScopeGlobal, &terminal, sizeof(terminal));
        if (terminal == (input ? kAudioStreamTerminalTypeHeadsetMicrophone : kAudioStreamTerminalTypeHeadphones))
            r.headsetTerminal = true;
        if (!input && terminal == kAudioStreamTerminalTypeSpeaker) r.speakerTerminal = true;
    }
    free(streams); return r;
}
// The input and output can be separate Core Audio devices with different clocks.
static double deviceRate(const Route *r) {
    Float64 hz = 0;
    property(r->dev,kAudioDevicePropertyNominalSampleRate,kAudioObjectPropertyScopeGlobal,&hz,sizeof(hz));
    return (isfinite(hz) && hz >= 8000 && hz <= 384000) ? hz : 48000;
}
typedef struct { double phase[2], gain; bool boosted; } Generator;
static void tones(Generator *g, float *stereo, UInt32 frames, double hz) {
    double increment[2] = {2*M_PI*toneHz[0]/hz, 2*M_PI*toneHz[1]/hz};
    double step=.25/fmax(1,lround(hz*.01)), target=g->boosted ? .5 : .25;
    for (UInt32 i=0; i<frames; ++i) {
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
static UInt32 inputFrames;
static double window[MaxBlock], coeff[6], pilotSine[2];
static PilotPhase blockAdvance[2];
// Fit the two known return tones to a short slice. Around its midpoint the
// sine terms are odd and the cosine terms are even. Two 2×2 systems separate
// the paddles even when a slice contains a fractional number of pilot cycles.
enum { SlicesPerWindow=4 };
typedef struct { double a, cross, b; } PairMatrix;
typedef struct {
    UInt32 count;
    double basis[(MaxBlock+SlicesPerWindow-1)/SlicesPerWindow][4];
    PairMatrix cosine, sine;
} PilotSlicePlan;
typedef struct {
    PilotPhase tone[2];
    double power[2], residual;
} PilotSlice;
static PilotSlicePlan slicePlan[SlicesPerWindow];
static UInt32 sliceEnd[SlicesPerWindow];
static PilotPhase sliceAdvance[SlicesPerWindow][2];
static PairMatrix inversePair(PairMatrix m) {
    double determinant=m.a*m.b-m.cross*m.cross;
    return (PairMatrix){m.b/determinant,-m.cross/determinant,m.a/determinant};
}
static void prepareSlice(PilotSlicePlan *plan, UInt32 count, double hz) {
    plan->count=count;
    PairMatrix cosine={0}, sine={0};
    for (UInt32 i=0;i<count;i++) {
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
    for (UInt32 i=0;i<plan->count;i++) {
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
    inputFrames = (UInt32)lround(hz*.01);
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
    for (UInt32 i=0; i<inputFrames; ++i) window[i] = .5-.5*cos(2*M_PI*i/inputFrames);
}
static void measurePilots(const float *samples, double amp[6], PilotPhase phase[2]) {
    double prev[6]={0}, prev2[6]={0};
    for (UInt32 i=0; i<inputFrames; ++i) {
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
    UInt32 markLength, markLeft, gapLeft;
    double rate, unitFrames, carry, phase, phaseStep;
    const AtomicToneSettings *settings;
    ToneSettings initialSettings;
    ToneRamps ramps;
    TypingQueue *typing;
    TypingDecoder decoder;
    uint64_t frame;
    const SidetoneLevel *volume;
    UInt32 volumeRamp;
    float volumeGain;
} Keyer;

static void configureKeyer(Keyer *k, double rate, double wpm) {
    initContacts(&k->wiredContacts);
    k->contacts=&k->wiredContacts;
    k->rate=rate; k->unitFrames=rate*1.2/wpm;
    k->initialSettings=defaultToneSettings; k->initialSettings.wpm=(uint8_t)wpm;
    k->volumeRamp=(UInt32)MAX(1,lround(rate*.005));
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
static UInt32 timedFrames(Keyer *k, unsigned units) {
    double exact = units*k->unitFrames+k->carry;
    UInt32 n = (UInt32)lround(exact);
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
        emitElement(k->stream,k->epoch,1,frame,k->rate,k->markLength);
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
        UInt32 position = k->markLength-k->markLeft;
        double gain=toneEnvelopeGain(&k->ramps,position);
        sample = (float)(.2*gain*sin(k->phase));
        k->phase += k->phaseStep;
        if (k->phase >= 2*M_PI) k->phase -= 2*M_PI;
    }
    if (--k->markLeft==0) {
        k->gapLeft=timedFrames(k,1);
        emitElement(k->stream,k->epoch,2,frame+1,k->rate,0);
    }
    return sample;
}
static bool renderKeyer(Keyer *k, UInt32 frames, float *output) {
    consumeContacts(k);
    bool silent = k->waitNeutral || (!k->first && !k->held && !k->pending && !k->markLeft && !k->gapLeft);
    if (k->typing) prepareTypingBlock(&k->decoder,k->typing,silent && !k->waitNeutral);
    if (silent) {
        if (output) memset(output,0,(size_t)frames*sizeof(float));
        k->last=0;
    } else if (output) {
        for (UInt32 i=0; i<frames; ++i) output[i]=nextKeyerSample(k,k->frame+i,true);
    } else {
        for (UInt32 i=0; i<frames; ++i) nextKeyerSample(k,k->frame+i,false);
    }
    k->frame+=frames;
    if (silent && !k->waitNeutral && k->frame>=k->nextWatermark) {
        emitElement(k->stream,k->epoch,0,k->frame,k->rate,0);
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
static bool applySidetoneVolume(Keyer *k, float *samples, UInt32 frames) {
    if (!k->volume || !frames) return false;
    float gain=k->volumeGain, target=levelGain(k->volume);
    if (gain==1 && target==1) return false;
    UInt32 ramp=gain==target ? 0 : MIN(frames,k->volumeRamp);
    if (ramp) {
        float step=(target-gain)/ramp;
        for (UInt32 i=0; i<ramp; ++i) { gain+=step; samples[i]*=gain; }
        k->volumeGain=target;
    }
    if (!target) memset(samples+ramp,0,(frames-ramp)*sizeof(float));
    else if (target!=1) for (UInt32 i=ramp; i<frames; ++i) samples[i]*=target;
    return !target && !ramp;
}
static OSStatus speakerRender(void *context, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *stamp,
                             UInt32 bus, UInt32 frames, AudioBufferList *audio) {
    (void)bus;
    Keyer *k = context;
    if (stamp && (stamp->mFlags & kAudioTimeStampSampleTimeValid)) {
        if (k->haveStamp && fabs(stamp->mSampleTime-k->nextSampleTime)>.5) interruptElements(k->stream);
        k->haveStamp=true; k->nextSampleTime=stamp->mSampleTime+frames;
    }
    if (!audio || !audio->mNumberBuffers) return kAudio_ParamError;
    // The client format below is planar float. Each speaker receives the same sidetone.
    size_t bytes = (size_t)frames*sizeof(float);
    for (UInt32 b=0; b<audio->mNumberBuffers; ++b) {
        AudioBuffer *buf = &audio->mBuffers[b];
        if (buf->mNumberChannels!=1 || !buf->mData || buf->mDataByteSize<bytes) return kAudio_ParamError;
        buf->mDataByteSize = (UInt32)bytes;
    }
    float *first = audio->mBuffers[0].mData;
    bool silent=renderKeyer(k,frames,first);
    if (applySidetoneVolume(k,first,frames)) silent=true;
    if (flags) {
        if (silent) *flags |= kAudioUnitRenderAction_OutputIsSilence;
        else *flags &= ~kAudioUnitRenderAction_OutputIsSilence;
    }
    for (UInt32 b=1; b<audio->mNumberBuffers; ++b) memcpy(audio->mBuffers[b].mData,first,bytes);
    return noErr;
}

typedef struct { Keyer keyer; AudioUnit unit; } Speaker;
static void stopSpeaker(Speaker *s) {
    if (!s->unit) return;
    AudioOutputUnitStop(s->unit);
    AudioUnitUninitialize(s->unit);
    AudioComponentInstanceDispose(s->unit);
    s->unit=NULL;
}
static bool speakerSelected(const Speaker *s, const Route *r) {
    AudioDeviceID actual=0; UInt32 size=sizeof(actual);
    return AudioUnitGetProperty(s->unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,
                                &actual,&size)==noErr && actual==r->dev;
}
static bool startSpeaker(Speaker *s, const Route *r, const AtomicToneSettings *settings, TypingQueue *typing, const SidetoneLevel *volume, ElementStream *stream, ContactQueue *contacts) {
    AudioComponentDescription desc={.componentType=kAudioUnitType_Output,
        .componentSubType=kAudioUnitSubType_HALOutput,.componentManufacturer=kAudioUnitManufacturer_Apple};
    AudioComponent component=AudioComponentFindNext(NULL,&desc);
    if (!component || !checked(AudioComponentInstanceNew(component,&s->unit),"Opening sidetone output")) goto fail;
    if (!checked(AudioUnitSetProperty(s->unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,
                                      &r->dev,sizeof(r->dev)),"Selecting sidetone output") || !speakerSelected(s,r)) goto fail;
    AudioStreamBasicDescription hardware={0}; UInt32 size=sizeof(hardware);
    if (!checked(AudioUnitGetProperty(s->unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Output,0,
                                      &hardware,&size),"Reading speaker format")) goto fail;
    double rate=hardware.mSampleRate;
    if (!isfinite(rate) || rate < 8000 || rate > 384000 || !hardware.mChannelsPerFrame) goto fail;
    AudioStreamBasicDescription client={.mSampleRate=rate,.mFormatID=kAudioFormatLinearPCM,
        .mFormatFlags=kAudioFormatFlagsNativeFloatPacked|kAudioFormatFlagIsNonInterleaved,
        .mBytesPerPacket=sizeof(float),.mFramesPerPacket=1,.mBytesPerFrame=sizeof(float),
        .mChannelsPerFrame=MIN(2u,hardware.mChannelsPerFrame),.mBitsPerChannel=32};
    if (!checked(AudioUnitSetProperty(s->unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Input,0,
                                      &client,sizeof(client)),"Setting speaker PCM format")) goto fail;
    configureKeyer(&s->keyer,rate,defaultToneSettings.wpm); s->keyer.settings=settings;
    if (contacts) s->keyer.contacts=contacts;
    s->keyer.typing=typing; s->keyer.stream=stream;
    s->keyer.volume=volume; s->keyer.volumeGain=levelGain(volume);
    AURenderCallbackStruct callback={speakerRender,&s->keyer};
    if (!checked(AudioUnitSetProperty(s->unit,kAudioUnitProperty_SetRenderCallback,kAudioUnitScope_Input,0,
                                      &callback,sizeof(callback)),"Connecting sidetone") ||
        !checked(AudioUnitInitialize(s->unit),"Initializing sidetone output") ||
        !checked(AudioOutputUnitStart(s->unit),"Starting sidetone output")) goto fail;
    return true;
fail:
    stopSpeaker(s);
    return false;
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
    UInt32 filled, sliceIndex;
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
static void acceptInput(Detector *d, Keyer *quiet, const float *src, UInt32 count) {
    while (count) {
        const PilotSlicePlan *plan=&slicePlan[d->sliceIndex];
        UInt32 end=sliceEnd[d->sliceIndex];
        UInt32 n=MIN(end-d->filled,count);
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

typedef struct {
    Detector detector;
    Speaker speaker;
    Keyer quietKeyer;
    AudioQueueRef in, out;
    UInt32 outputFrames;
    double inHz, outHz, expectedInputTime;
    bool receivedInput, haveInputTime, captureQueueError;
    Generator generator;
    OSStatus callbackError;
    // AudioQueue callbacks run on this worker's CFRunLoop. Copy reports here
    // and deliver them after CFRunLoopRunInMode returns.
    struct { unsigned mask; bool swapped; double at; } reports[128];
    unsigned reportCount;
    bool reportsLost, capturePending, captureSampling, captureBoosted, haveProfile;
    PaddleCalibrationStep captureStep;
    InputProfile captureProfile;
    bool closing;
    double lastIn, lastOut;
} Session;
static void prepareQuietKeyer(Session *s, TypingQueue *typing, const AtomicToneSettings *settings) {
    memset(&s->quietKeyer,0,sizeof(s->quietKeyer));
    configureKeyer(&s->quietKeyer,s->inHz,defaultToneSettings.wpm); s->quietKeyer.settings=settings;
    s->quietKeyer.typing=typing;
}
static void fillOutput(Session *s, AudioQueueBufferRef buf) {
    tones(&s->generator,buf->mAudioData,s->outputFrames,s->outHz);
    buf->mAudioDataByteSize = s->outputFrames*2*sizeof(float);
}
static void outputCallback(void *context, AudioQueueRef queue, AudioQueueBufferRef buf) {
    Session *s = context;
    if (s->closing || s->callbackError) return;
    s->lastOut = monotonicSeconds(); fillOutput(s, buf);
    s->callbackError = AudioQueueEnqueueBuffer(queue, buf, 0, NULL);
}
static void receiveInput(Session *s, const float *samples, UInt32 frames, const AudioTimeStamp *stamp) {
    if (!frames) return;
    bool validTime=stamp && (stamp->mFlags & kAudioTimeStampSampleTimeValid) && isfinite(stamp->mSampleTime);
    if (s->receivedInput && (validTime!=s->haveInputTime ||
        (validTime && fabs(stamp->mSampleTime-s->expectedInputTime)>.5))) {
        interruptElements(s->quietKeyer.stream);
        resetContactEvidence(&s->detector); s->detector.waitForRelease=true;
        if (s->detector.sampling) {
            s->detector.sampling=false;
            notifyCapture(&s->detector,s->detector.step);
        }
    }
    s->receivedInput=true; s->haveInputTime=validTime;
    if (validTime) s->expectedInputTime=stamp->mSampleTime+frames;
    s->lastIn=monotonicSeconds();
    acceptInput(&s->detector,&s->quietKeyer,samples,frames);
    s->generator.boosted=s->detector.step ? s->detector.trialBoost : s->detector.profile.boosted;
}
static void inputCallback(void *context, AudioQueueRef queue, AudioQueueBufferRef buf,
                          const AudioTimeStamp *stamp, UInt32 packets, const AudioStreamPacketDescription *desc) {
    (void)packets; (void)desc;
    Session *s=context;
    if (s->closing || s->callbackError) return;
    receiveInput(s,buf->mAudioData,buf->mAudioDataByteSize/sizeof(float),stamp);
    s->callbackError=AudioQueueEnqueueBuffer(queue,buf,0,NULL);
    s->captureQueueError=s->callbackError!=noErr;
}
static bool sameDevice(AudioQueueRef queue, const Route *r) {
    CFStringRef selected = NULL; UInt32 size = sizeof(selected);
    if (!checked(AudioQueueGetProperty(queue, kAudioQueueProperty_CurrentDevice, &selected, &size),
                 "Checking audio queue device")) return false;
    char uid[512] = {0}; copyString(selected, uid, sizeof(uid));
    if (!strcmp(uid, r->uid)) return true;
    say("Audio queue changed device. Expected %s, got %s.", r->uid, uid); return false;
}
static bool prepareQueue(Session *s, const Route *r, bool shortCapture) {
    UInt32 channels = r->input ? 1 : 2;
    AudioStreamBasicDescription fmt = {.mSampleRate=r->input ? s->inHz : s->outHz, .mFormatID=kAudioFormatLinearPCM,
        .mFormatFlags=kAudioFormatFlagsNativeFloatPacked, .mBytesPerPacket=channels*sizeof(float),
        .mFramesPerPacket=1, .mBytesPerFrame=channels*sizeof(float), .mChannelsPerFrame=channels, .mBitsPerChannel=32};
    AudioQueueRef *queue = r->input ? &s->in : &s->out;
    // Serial callbacks on this run loop also own all DSP and UI state.
    CFRunLoopRef loop = CFRunLoopGetCurrent();
    OSStatus status = r->input ? AudioQueueNewInput(&fmt,inputCallback,s,loop,kCFRunLoopDefaultMode,0,queue) :
                                 AudioQueueNewOutput(&fmt,outputCallback,s,loop,kCFRunLoopDefaultMode,0,queue);
    if (!checked(status, r->input ? "Creating headset input" : "Creating headphone output")) return false;
    CFStringRef target = CFStringCreateWithCString(NULL,r->uid,kCFStringEncodingUTF8);
    if (!target) { say("Invalid Core Audio device identifier."); return false; }
    status = AudioQueueSetProperty(*queue, kAudioQueueProperty_CurrentDevice, &target, sizeof(target));
    CFRelease(target);
    if (!checked(status,r->input ? "Selecting headset microphone" : "Selecting headphone output") || !sameDevice(*queue, r)) return false;
    // Deliver each short slice as soon as it fills. Keep the same total
    // capture capacity across a delayed callback, including odd window sizes.
    UInt32 defaultFrames=r->input ? inputFrames : s->outputFrames;
    int buffers=shortCapture ? SlicesPerWindow*QueueBuffers : QueueBuffers;
    for (int i=0; i<buffers; ++i) {
        UInt32 frames=shortCapture ? slicePlan[i%SlicesPerWindow].count : defaultFrames;
        AudioQueueBufferRef buf;
        if (!checked(AudioQueueAllocateBuffer(*queue, frames*fmt.mBytesPerFrame, &buf), "Allocating buffer")) return false;
        if (!r->input) fillOutput(s, buf);
        if (!checked(AudioQueueEnqueueBuffer(*queue, buf, 0, NULL), "Queuing buffer")) return false;
    }
    return true;
}

@interface SoundOutput : NSObject
@property Route route;
@property (copy) NSString *uid, *name;
@property BOOL bluetooth;
@end
@implementation SoundOutput
@end

typedef struct { Route input, output; unsigned inputs, outputs; } JackRoutes;
static BOOL bluetoothOutput(const Route *r) {
    return !r->input && r->alive && r->channels && r->uid[0] &&
        (r->transport==kAudioDeviceTransportTypeBluetooth || r->transport==kAudioDeviceTransportTypeBluetoothLE);
}
static NSArray<SoundOutput *> *scanOutputs(JackRoutes *jack) {
    NSMutableArray *result=[NSMutableArray array];
    UInt32 size=0;
    AudioDeviceID *ids=propertyArray(kAudioObjectSystemObject,kAudioHardwarePropertyDevices,kAudioObjectPropertyScopeGlobal,&size);
    for (size_t i=0; ids && i<size/sizeof(*ids); ++i) {
        Route input=inspect(ids[i],true), output=inspect(ids[i],false);
        if (wired(&input)) { jack->input=input; ++jack->inputs; }
        if (wired(&output)) { jack->output=output; ++jack->outputs; continue; }
        if (!builtInSpeaker(&output) && !bluetoothOutput(&output)) continue;
        SoundOutput *candidate=[SoundOutput new];
        candidate.route=output; candidate.uid=@(output.uid); candidate.name=@(output.name);
        candidate.bluetooth=bluetoothOutput(&output); [result addObject:candidate];
    }
    free(ids);
    [result sortUsingComparator:^NSComparisonResult(SoundOutput *a, SoundOutput *b) { return [a.uid compare:b.uid]; }];
    return result;
}
static SoundOutput *chooseOutput(NSArray<SoundOutput *> *options, NSString *choice, AudioDeviceID systemOutput,
                                 AudioDeviceID wiredOutput, NSString *recentBluetooth) {
    SoundOutput *speaker=nil, *selected=nil, *recent=nil, *airpods=nil;
    for (SoundOutput *item in options) {
        if ([item.uid isEqual:choice]) return item;
        if (!item.bluetooth && !speaker) speaker=item;
        if (item.route.dev==systemOutput) selected=item;
        if (item.bluetooth && [item.uid isEqual:recentBluetooth]) recent=item;
        if (item.bluetooth && [item.name localizedCaseInsensitiveContainsString:@"AirPods"] && !airpods) airpods=item;
    }
    if ([choice isEqual:@"speakers"]) return speaker;
    if (![choice isEqual:@"auto"]) return nil;  // Explicit headphones may reconnect later.
    if (selected) return selected;
    if (systemOutput==wiredOutput && wiredOutput) return recent ?: airpods ?: speaker;
    return speaker;
}
static void closeAudio(Session *s) {
    s->closing=true;
    s->detector.keyer=NULL;
    stopSpeaker(&s->speaker);
    if (s->out) AudioQueueDispose(s->out,true);
    if (s->in) AudioQueueDispose(s->in,true);
    memset(s,0,sizeof(*s));
}
@interface MorseEngine ()
@property (atomic) BOOL stopping;
- (instancetype)initWithDefaults:(NSUserDefaults *)defaults;
- (ContactQueue *)vbandContactQueue;
- (void)contacts:(unsigned)mask swapped:(BOOL)swapped;
- (void)inputStep:(PaddleCalibrationStep)step sampling:(BOOL)sampling boosted:(BOOL)boosted profile:(const InputProfile *)profile;
@end
static void deliverContact(void *context, unsigned mask, bool swapped) {
    Session *s=context;
    if (s->reportCount>=128) { s->reportsLost=true; return; }
    s->reports[s->reportCount++]=(typeof(s->reports[0])){mask,swapped,paddleTimeMs()};
}
static void deliverInputStep(void *context, PaddleCalibrationStep step, bool sampling, bool boosted, const InputProfile *profile) {
    Session *s=context;
    s->capturePending=true; s->captureStep=step; s->captureSampling=sampling; s->captureBoosted=boosted;
    s->haveProfile=profile!=NULL;
    if (profile) s->captureProfile=*profile;
}
typedef NS_ENUM(unsigned, InputRequest) { NoInputRequest, BeginInput, SampleNormal, SampleBoosted, CancelInput, AutomaticInput };
static NSString *const inputProfilePreference=@"wiredPaddleInputProfile";
static NSString *const swapPreference=@"paddlesSwapped";
static NSString *const tonePreference=@"sidetoneSettings";
static NSInteger bounded(NSInteger v, NSInteger low, NSInteger high) { return MAX(low,MIN(high,v)); }
static NSInteger storedNumber(NSDictionary *stored, NSString *key, NSInteger fallback, NSInteger low, NSInteger high) {
    NSNumber *number=stored[key];
    return [number isKindOfClass:NSNumber.class] ? bounded(number.integerValue,low,high) : fallback;
}
@implementation MorseEngine {
    dispatch_group_t _workers;
    NSString *_phase, *_detail, *_audioText;
    NSArray *_lastOptions;
    unsigned _mask;
    double _contactTime;
    TypingQueue _typing;
    ElementStream _elements;
    SidetoneLevel _volume;
    atomic_bool _swapRequested;
    BOOL _swappedForPress;
    AtomicToneSettings _tone;
    NSUserDefaults *_preferences;
    NSArray<NSString *> *_inputDevices;
    atomic_uint _inputRequest;
    atomic_uint _requestedRoute; // low two bits are the source, high bits distinguish visits
    unsigned _workerRoute;
    ContactQueue _vbandContacts;
}
- (instancetype)init { return [self initWithDefaults:NSUserDefaults.standardUserDefaults]; }
- (instancetype)initWithDefaults:(NSUserDefaults *)defaults {
    if ((self=[super init])) {
        _outputChoice=@"auto"; _workers=dispatch_group_create(); initTypingQueue(&_typing);
        atomic_init(&_volume.percent,100); atomic_init(&_volume.muted,false);
        atomic_init(&_inputRequest,NoInputRequest);
        atomic_init(&_requestedRoute,PaddleInputAudio);
        initContacts(&_vbandContacts);
        _preferences=defaults;
        atomic_init(&_swapRequested,[defaults boolForKey:swapPreference]);
        NSDictionary *saved=[defaults dictionaryForKey:tonePreference];
        ToneSettings tone=defaultToneSettings;
        tone.pitchHz=(uint16_t)storedNumber(saved,@"pitchHz",tone.pitchHz,MinToneHz,MaxToneHz);
        tone.wpm=(uint8_t)storedNumber(saved,@"wpm",tone.wpm,MinKeyerWPM,MaxKeyerWPM);
        tone.riseMs=(uint8_t)storedNumber(saved,@"riseMs",tone.riseMs,MinRampMs,MaxRampMs);
        tone.fallMs=(uint8_t)storedNumber(saved,@"fallMs",tone.fallMs,MinRampMs,MaxRampMs);
        tone.curve=(uint8_t)storedNumber(saved,@"curve",tone.curve,RaisedCosine,ExponentialRamp);
        tone.spacingWpm=(uint8_t)storedNumber(saved,@"spacingWpm",MIN(tone.spacingWpm,tone.wpm),MinSpacingWPM,tone.wpm);
        tone.options=(uint8_t)storedNumber(saved,@"options",0,0,UseFarnsworth|TimedWordSpaces|IambicModeB|TrainerGapThresholds);
        atomic_init(&_tone,tone);
    }
    return self;
}
- (void)report:(NSString *)phase detail:(NSString *)detail mask:(unsigned)mask {
    if ([_phase isEqual:phase] && [_detail isEqual:detail] && _mask==mask) return;
    _phase=phase; _detail=detail; _mask=mask;
    double ms=_contactTime ? _contactTime : paddleTimeMs();
    BOOL swapped=_swappedForPress;
    unsigned route=_workerRoute;
    dispatch_async(dispatch_get_main_queue(),^{ if (route==atomic_load(&self->_requestedRoute) && self.stateChanged) self.stateChanged(phase,detail,mask,ms,swapped); });
}
- (void)contacts:(unsigned)mask swapped:(BOOL)swapped {
    _swappedForPress=swapped; [self report:@"ready" detail:@"Ready for paddle input" mask:mask];
}
- (void)beginInputCalibration { atomic_store(&_inputRequest,BeginInput); }
- (void)sampleInputCalibrationBoosted:(BOOL)boosted { atomic_store(&_inputRequest,boosted ? SampleBoosted : SampleNormal); }
- (void)cancelInputCalibration { atomic_store(&_inputRequest,CancelInput); }
- (void)useAutomaticInputLevels { atomic_store(&_inputRequest,AutomaticInput); }
- (InputProfile)inputProfileForDevices:(NSArray<NSString *> *)devices {
    _inputDevices=[devices copy];
    NSDictionary *saved=[_preferences dictionaryForKey:inputProfilePreference];
    InputProfile profile={0};
    if (![devices isEqual:saved[@"devices"]]) return profile;
    NSArray *on=saved[@"press"], *off=saved[@"release"];
    if (![on isKindOfClass:NSArray.class] || ![off isKindOfClass:NSArray.class] || on.count!=2 || off.count!=2) return profile;
    for (int k=0;k<2;++k) {
        if (![on[k] isKindOfClass:NSNumber.class] || ![off[k] isKindOfClass:NSNumber.class]) return (InputProfile){0};
        profile.on[k]=[on[k] doubleValue]; profile.off[k]=[off[k] doubleValue];
        if (!(profile.off[k]>0 && profile.on[k]>profile.off[k] && isfinite(profile.on[k]))) return (InputProfile){0};
    }
    profile.boosted=[saved[@"boosted"] isEqual:@YES]; return profile;
}
- (void)inputStep:(PaddleCalibrationStep)step sampling:(BOOL)sampling boosted:(BOOL)boosted profile:(const InputProfile *)profile {
    if (profile && _inputDevices) {
        [_preferences setObject:@{@"devices":_inputDevices,@"press":@[@(profile->on[0]),@(profile->on[1])],
            @"release":@[@(profile->off[0]),@(profile->off[1])],@"boosted":@(profile->boosted)} forKey:inputProfilePreference];
    }
    if (step==InputCalibrated || step==InputOverlap)
        [self report:@"calibrating" detail:@"Release both paddles to resume" mask:0];
    unsigned route=_workerRoute;
    dispatch_async(dispatch_get_main_queue(),^{
        if (route==atomic_load(&self->_requestedRoute) && self.inputCalibrationChanged) self.inputCalibrationChanged(step,sampling,boosted);
    });
}
- (void)handleInputRequest:(InputRequest)request session:(Session *)s running:(BOOL)running {
    Detector *d=&s->detector;
    if (!running) {
        if (request!=CancelInput) [self inputStep:InputUnavailable sampling:NO boosted:NO profile:NULL];
        return;
    }
    switch (request) {
        case BeginInput:
            [self interruptInput]; beginCapture(d);
            [self report:@"calibrating" detail:@"Measuring paddle input" mask:0]; break;
        case SampleNormal: case SampleBoosted:
            samplePosition(d,request==SampleBoosted); break;
        case CancelInput: case AutomaticInput:
            if (request==AutomaticInput) {
                if ([_inputDevices isEqual:[_preferences dictionaryForKey:inputProfilePreference][@"devices"]])
                    [_preferences removeObjectForKey:inputProfilePreference];
                d->profile=(InputProfile){0};
                // The previous automatic floor may have been taken with boosted pilots or a held key.
                d->calibrated=0;
            } else if (!d->step) break;
            endCapture(d); [self report:@"calibrating" detail:@"Release both paddles to resume" mask:0]; break;
        case NoInputRequest: break;
    }
    s->generator.boosted=d->step ? d->trialBoost : d->profile.boosted;
}
- (BOOL)paddlesSwapped { return atomic_load(&_swapRequested); }
- (void)setPaddlesSwapped:(BOOL)swapped {
    atomic_store(&_swapRequested,swapped);
    [_preferences setBool:swapped forKey:swapPreference];
}
- (ToneSettings)toneSettings { return atomic_load(&_tone); }
- (void)setToneSettings:(ToneSettings)t {
    t.pitchHz=(uint16_t)bounded(t.pitchHz,MinToneHz,MaxToneHz);
    t.wpm=(uint8_t)bounded(t.wpm,MinKeyerWPM,MaxKeyerWPM);
    t.riseMs=(uint8_t)bounded(t.riseMs,MinRampMs,MaxRampMs);
    t.fallMs=(uint8_t)bounded(t.fallMs,MinRampMs,MaxRampMs);
    t.curve=(uint8_t)bounded(t.curve,RaisedCosine,ExponentialRamp);
    t.spacingWpm=(uint8_t)bounded(t.spacingWpm,MinSpacingWPM,t.wpm);
    t.options &= UseFarnsworth|TimedWordSpaces|IambicModeB|TrainerGapThresholds;
    ToneSettings previous=atomic_load(&_tone);
    if (!memcmp(&previous,&t,sizeof(t))) return;
    atomic_store(&_tone,t);
    [_preferences setObject:@{@"pitchHz":@(t.pitchHz),@"wpm":@(t.wpm),@"riseMs":@(t.riseMs),
        @"fallMs":@(t.fallMs),@"curve":@(t.curve),@"spacingWpm":@(t.spacingWpm),@"options":@(t.options)} forKey:tonePreference];
}
- (unsigned)sidetoneVolume { return atomic_load(&_volume.percent); }
- (void)setSidetoneVolume:(unsigned)volume { atomic_store(&_volume.percent,MIN(volume,100u)); }
- (BOOL)sidetoneMuted { return atomic_load(&_volume.muted); }
- (void)setSidetoneMuted:(BOOL)muted { atomic_store(&_volume.muted,muted); }
- (PaddleInputMode)inputMode { return (PaddleInputMode)(atomic_load(&_requestedRoute)&3u); }
- (void)setInputMode:(PaddleInputMode)mode {
    unsigned old=atomic_load(&_requestedRoute);
    if (mode>PaddleInputOff || (old&3u)==mode) return;
    queueContacts(&_vbandContacts,0);
    atomic_store(&_inputRequest,NoInputRequest);
    atomic_store(&_requestedRoute,((old&~3u)+4u)|mode);
    [self interruptInput];
}
- (ContactQueue *)vbandContactQueue { return &_vbandContacts; }
- (void)setVBandContacts:(unsigned)mask {
    if (mask>3 || self.inputMode!=PaddleInputVBand) return;
    unsigned logical=self.paddlesSwapped ? ((mask&1u)<<1)|((mask&2u)>>1) : mask;
    queueContacts(&_vbandContacts,logical);
}
- (unsigned)elementEpoch { return atomic_load(&_elements.epoch); }
- (BOOL)takeElement:(ElementEvent *)event { return takeElement(&_elements,event); }
- (void)interruptInput { interruptElements(&_elements); selectTypingDestination(&_typing,0); }
- (void)setTypingDestination:(pid_t)pid { selectTypingDestination(&_typing,pid); }
- (void)drainTypedCharacters:(void (^)(pid_t, char, BOOL))receive {
    TypedCharacter event;
    while (takeTypedCharacter(&_typing,&event))
        receive((pid_t)(uint32_t)event.destination,event.character,event.spaceBefore);
}
- (void)reportOptions:(NSArray<SoundOutput *> *)options text:(NSString *)text {
    NSMutableArray *mapped=[NSMutableArray array];
    for (SoundOutput *o in options) if (o.bluetooth) [mapped addObject:@{@"id":o.uid,@"name":o.name}];
    if ([_lastOptions isEqual:mapped] && [_audioText isEqual:text]) return;
    NSArray *items=[mapped copy]; _lastOptions=items; _audioText=text;
    unsigned route=_workerRoute;
    dispatch_async(dispatch_get_main_queue(),^{ if (route==atomic_load(&self->_requestedRoute) && self.outputsChanged) self.outputsChanged(items,text); });
}
- (void)start {
    self.stopping=NO;
    dispatch_group_async(_workers,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{ [self runAudio]; });
}
- (void)stop {
    self.stopping=YES;
    dispatch_group_wait(_workers,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC));
}
- (void)runAudio {
    Session s={0};
    BOOL running=NO, asked=NO, reportedAdapter=NO, lastPaired=NO;
    NSString *recentBluetooth=nil, *playingUID=nil;
    double nextScan=0, retryAudio=0, retryTone=0;
    AudioDeviceID inputID=0, outputID=0, standardCaptureDevice=0;
    _workerRoute=UINT_MAX;
    while (!self.stopping) @autoreleasepool {
        unsigned route=atomic_load(&_requestedRoute);
        PaddleInputMode mode=(PaddleInputMode)(route&3u);
        if (_workerRoute!=route) {
            closeAudio(&s);
            _workerRoute=route; running=NO; asked=NO; reportedAdapter=NO;
            _phase=nil; _detail=nil; _audioText=nil; playingUID=nil;
            nextScan=retryTone=retryAudio=0; inputID=outputID=standardCaptureDevice=0;
        }
        if (mode==PaddleInputOff) { [NSThread sleepForTimeInterval:.05]; continue; }
        if (running) CFRunLoopRunInMode(kCFRunLoopDefaultMode,.024,false);
        else [NSThread sleepForTimeInterval:.05];
        if (route!=atomic_load(&_requestedRoute)) continue;
        if (s.reportsLost) { [self interruptInput]; s.reportCount=0; s.reportsLost=false; }
        for (unsigned i=0;i<s.reportCount;i++) {
            _contactTime=s.reports[i].at;
            [self contacts:s.reports[i].mask swapped:s.reports[i].swapped];
        }
        _contactTime=0; s.reportCount=0;
        if (s.capturePending) {
            [self inputStep:s.captureStep sampling:s.captureSampling boosted:s.captureBoosted profile:s.haveProfile ? &s.captureProfile : NULL];
            s.capturePending=false;
        }
        double now=monotonicSeconds();
        InputRequest request=atomic_exchange(&_inputRequest,NoInputRequest);
        if (request!=NoInputRequest && mode==PaddleInputAudio) [self handleInputRequest:request session:&s running:running];
        if (now<nextScan && !s.callbackError) continue;
        nextScan=now+.40;
        JackRoutes jack={0};
        NSArray<SoundOutput *> *options=scanOutputs(&jack);
        BOOL paired=jack.inputs==1 && jack.outputs==1;
        if (mode==PaddleInputAudio && (!reportedAdapter || paired!=lastPaired)) {
            reportedAdapter=YES; lastPaired=paired;
            dispatch_async(dispatch_get_main_queue(),^{ if (route==atomic_load(&self->_requestedRoute) && self.adapterConnectionChanged) self.adapterConnectionChanged(paired); });
        }
        AudioDeviceID systemOutput=0;
        property(kAudioObjectSystemObject,kAudioHardwarePropertyDefaultOutputDevice,kAudioObjectPropertyScopeGlobal,
                 &systemOutput,sizeof(systemOutput));
        for (SoundOutput *o in options) if (o.bluetooth && o.route.dev==systemOutput) recentBluetooth=o.uid;
        SoundOutput *chosen=chooseOutput(options,self.outputChoice,systemOutput,jack.output.dev,recentBluetooth);
        NSString *audioText=chosen ? [NSString stringWithFormat:@"Output · %@",chosen.name] : @"Waiting for selected audio output";
        if (running && (!paired || jack.input.dev!=inputID || jack.output.dev!=outputID ||
            s.callbackError || now-s.lastIn>3 || now-s.lastOut>3 ||
            !sameDevice(s.in,&jack.input) || !sameDevice(s.out,&jack.output))) {
            if (paired && jack.input.dev==inputID && (s.captureQueueError || (now-s.lastIn>3 && now-s.lastOut<=3)))
                standardCaptureDevice=inputID;
            if (s.detector.step) [self inputStep:InputUnavailable sampling:NO boosted:NO profile:NULL];
            closeAudio(&s); running=NO; playingUID=nil; retryTone=0; retryAudio=now+.6;
            [self interruptInput];
            [self report:@"disconnected" detail:@"Paddle disconnected" mask:0];
        }
        if (mode==PaddleInputAudio && !paired) {
            standardCaptureDevice=0;
            NSString *message=jack.outputs==1 && !jack.inputs ? @"Plug fully into the jack · headset mic missing" :
                @"Connect the paddle adapter to the 3.5 mm jack";
            [self report:@"waiting" detail:message mask:0];
            [self reportOptions:options text:audioText]; continue;
        }
        if (mode==PaddleInputAudio && !running) {
            AVAuthorizationStatus auth=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
            if (auth!=AVAuthorizationStatusAuthorized) {
                if (auth==AVAuthorizationStatusNotDetermined && !asked) {
                    asked=YES;
                    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL allow){ (void)allow; }];
                }
                [self report:@"permission" detail:auth==AVAuthorizationStatusNotDetermined ?
                    @"Allow microphone access to read the paddle" : @"Allow Morse under Privacy & Security → Microphone" mask:0];
                [self reportOptions:options text:audioText]; continue;
            }
            if (now<retryAudio) { [self reportOptions:options text:audioText]; continue; }
            s.inHz=deviceRate(&jack.input); s.outHz=deviceRate(&jack.output);
            [self interruptInput]; prepareQuietKeyer(&s,&_typing,&_tone); s.quietKeyer.stream=&_elements;
            makeTables(s.inHz); s.outputFrames=(UInt32)lround(s.outHz*.01);
            s.detector.context=&s; s.detector.change=deliverContact;
            s.detector.swapRequested=&_swapRequested;
            s.detector.captureChanged=deliverInputStep;
            s.detector.profile=[self inputProfileForDevices:@[@(jack.input.uid),@(jack.output.uid)]];
            s.detector.waitForRelease=true;
            s.generator.boosted=s.detector.profile.boosted;
            bool shortCapture=standardCaptureDevice!=jack.input.dev;
            bool inputReady=prepareQueue(&s,&jack.input,shortCapture);
            bool pilotsStarted=inputReady && prepareQueue(&s,&jack.output,false) &&
                checked(AudioQueueStart(s.out,NULL),"Starting wired pilots");
            if (!pilotsStarted || !checked(AudioQueueStart(s.in,NULL),"Starting headset return")) {
                bool retryStandard=shortCapture && (!inputReady || pilotsStarted);
                if (retryStandard) standardCaptureDevice=jack.input.dev;
                closeAudio(&s); retryAudio=now+(retryStandard ? .1 : 2);
                [self report:@"error" detail:retryStandard ? @"Retrying the audio converter with standard capture buffers" :
                    @"Could not open the wired audio ports · retrying" mask:0];
                [self reportOptions:options text:audioText]; continue;
            }
            running=YES; s.lastIn=s.lastOut=monotonicSeconds();
            inputID=jack.input.dev; outputID=jack.output.dev;
            [self report:@"calibrating" detail:@"Calibrating · release both paddles" mask:0];
        }
        Route toneRoute=chosen ? chosen.route : (Route){0};
        if (s.speaker.unit && (![playingUID isEqual:chosen.uid] || !speakerSelected(&s.speaker,&toneRoute))) {
            s.detector.keyer=NULL; stopSpeaker(&s.speaker); playingUID=nil; retryTone=0;
            [self interruptInput];
            if (running) { prepareQuietKeyer(&s,&_typing,&_tone); s.quietKeyer.stream=&_elements; }
        }
        if (chosen && !s.speaker.unit && now>=retryTone && toneRoute.dev!=outputID) {
            memset(&s.speaker,0,sizeof(s.speaker));
            interruptElements(&_elements);
            if (startSpeaker(&s.speaker,&toneRoute,&_tone,&_typing,&_volume,&_elements,mode==PaddleInputVBand ? self.vbandContactQueue : NULL)) {
                playingUID=chosen.uid;
                if (running) {
                    s.detector.keyer=&s.speaker.keyer;
                    setPaddles(s.detector.keyer,logicalContacts(&s.detector));
                }
            } else retryTone=now+2;
        }
        if (chosen && !s.speaker.unit) audioText=[NSString stringWithFormat:@"Waiting to open %@",chosen.name];
        [self reportOptions:options text:audioText];
        if (mode==PaddleInputVBand) {
            [self report:s.speaker.unit ? @"ready" : @"waiting"
                  detail:s.speaker.unit ? @"VBand USB · ready for Control key input" : audioText mask:0];
        }
    }
    closeAudio(&s);
}
@end
