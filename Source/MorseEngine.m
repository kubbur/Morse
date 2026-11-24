#import "MorseEngine.h"
#include "MorseTyping.h"
#include "PaddleClock.h"
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#include <CoreAudio/CoreAudio.h>
#include <AudioToolbox/AudioToolbox.h>
#include <AudioUnit/AudioUnit.h>
#include <math.h>
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
static void makeTables(double hz) {
    inputFrames = (UInt32)lround(hz*.01);
    const int bins[6] = {1000, 1600, 800, 1200, 1400, 1800};
    for (int k=0; k<6; ++k) coeff[k] = 2*cos(2*M_PI*bins[k]/hz);
    for (int k=0; k<2; ++k) {
        double w=2*M_PI*toneHz[k]/hz;
        pilotSine[k]=sin(w);
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
    // The input thread publishes held contacts in bits 0–1 and new presses in bits 2–3.
    // All other fields belong to the loudspeaker's render thread after startup.
    atomic_uint contacts;
    unsigned held, pending, last;
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
    atomic_init(&k->contacts, 0);
    k->rate=rate; k->unitFrames=rate*1.2/wpm;
    k->initialSettings=defaultToneSettings; k->initialSettings.wpm=(uint8_t)wpm;
    k->volumeRamp=(UInt32)MAX(1,lround(rate*.005));
    k->volumeGain=1;
}
static void setPaddles(Keyer *k, unsigned held) {
    unsigned old = atomic_load_explicit(&k->contacts,memory_order_relaxed);
    unsigned update;
    do {
        unsigned pressed = held & ~old;
        update = (old & 12u) | held | (pressed << 2);
    } while (!atomic_compare_exchange_weak_explicit(&k->contacts,&old,update,
                                                     memory_order_relaxed,memory_order_relaxed));
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
        unsigned requested = k->held | k->pending;
        if (!requested) { k->last=0; return 0; }
        k->last = requested==3 ? (k->last==1 ? 2 : 1) : requested;
        k->pending &= ~k->last;
        ToneSettings tone=k->settings ? atomic_load_explicit(k->settings,memory_order_relaxed) : k->initialSettings;
        double unit=k->rate*1.2/tone.wpm;
        if (k->unitFrames!=unit) { k->unitFrames=unit; k->carry=0; }
        k->markLength = k->markLeft = timedFrames(k,k->last==1 ? 1 : 3);
        if (sound) {
            k->phaseStep=2*M_PI*tone.pitchHz/k->rate;
            k->ramps=fitToneRamps(tone,k->rate,k->markLength);
        }
        if (k->decoder.armed)
            typeMark(&k->decoder,k->typing,k->last,frame,k->markLength,
                     k->rate*spacingUnitMs(tone)/1000,(tone.options & TimedWordSpaces)!=0);
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
    if (--k->markLeft==0) k->gapLeft=timedFrames(k,1);
    return sample;
}
static bool renderKeyer(Keyer *k, UInt32 frames, float *output) {
    unsigned contacts = atomic_fetch_and_explicit(&k->contacts,3u,memory_order_relaxed);
    k->held = contacts & 3u;
    k->pending |= contacts >> 2;
    bool silent = !k->held && !k->pending && !k->markLeft && !k->gapLeft;
    if (k->typing) prepareTypingBlock(&k->decoder,k->typing,silent);
    if (silent) {
        if (output) memset(output,0,(size_t)frames*sizeof(float));
        k->last=0;
    } else if (output) {
        for (UInt32 i=0; i<frames; ++i) output[i]=nextKeyerSample(k,k->frame+i,true);
    } else {
        for (UInt32 i=0; i<frames; ++i) nextKeyerSample(k,k->frame+i,false);
    }
    k->frame+=frames;
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
    (void)stamp; (void)bus;
    Keyer *k = context;
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
static bool startSpeaker(Speaker *s, const Route *r, const AtomicToneSettings *settings, TypingQueue *typing, const SidetoneLevel *volume) {
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
    s->keyer.typing=typing;
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
    d->stable=0; d->neutralFrames=0;
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
static void setIdleLevel(Detector *d, int k, double level) {
    d->idleLevel[k]=level;
    d->on[k]=fmax(.00008,level*2.3+.00003);
    d->off[k]=fmax(.000045,level*1.6+.000015);
}
static void detect(Detector *d, const float *samples) {
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
    if (d->stable!=bits) {
        // Latch the layout on the first debounced press. A held paddle or squeeze
        // keeps its meaning until both physical contacts have been released.
        if (!d->stable && d->swapRequested)
            d->swappedForPress=atomic_load_explicit(d->swapRequested,memory_order_relaxed);
        d->stable = bits;
        unsigned mask=logicalContacts(d);
        if (d->keyer) setPaddles(d->keyer,mask);
        if (d->change) d->change(d->context,mask,d->swappedForPress);
    }
}

typedef struct {
    Detector detector;
    Speaker speaker;
    Keyer quietKeyer;
    AudioQueueRef in, out;
    float partial[MaxBlock];
    UInt32 filled, outputFrames;
    double inHz, outHz;
    Generator generator;
    OSStatus callbackError;
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
static void inputCallback(void *context, AudioQueueRef queue, AudioQueueBufferRef buf,
                          const AudioTimeStamp *stamp, UInt32 packets, const AudioStreamPacketDescription *desc) {
    (void)stamp; (void)packets; (void)desc;
    Session *s = context;
    if (s->closing || s->callbackError) return;
    const float *src = buf->mAudioData; unsigned left = buf->mAudioDataByteSize/sizeof(float);
    if (left) s->lastIn = monotonicSeconds();
    while (left) {
        unsigned n = inputFrames-s->filled; if (n > left) n = left;
        memcpy(&s->partial[s->filled], src, n*sizeof(float)); s->filled += n; src += n; left -= n;
        if (s->filled == inputFrames) {
            // The wired clock drives the same keyer when the selected audio output is away.
            if (!s->detector.keyer && s->detector.calibrated>=SettleBlocks+IdleBlocks) {
                setPaddles(&s->quietKeyer,logicalContacts(&s->detector));
                renderKeyer(&s->quietKeyer,inputFrames,NULL);
            }
            detect(&s->detector,s->partial); s->filled=0;
            s->generator.boosted=s->detector.step ? s->detector.trialBoost : s->detector.profile.boosted;
        }
    }
    s->callbackError = AudioQueueEnqueueBuffer(queue, buf, 0, NULL);
}
static bool sameDevice(AudioQueueRef queue, const Route *r) {
    CFStringRef selected = NULL; UInt32 size = sizeof(selected);
    if (!checked(AudioQueueGetProperty(queue, kAudioQueueProperty_CurrentDevice, &selected, &size),
                 "Checking audio queue device")) return false;
    char uid[512] = {0}; copyString(selected, uid, sizeof(uid));
    if (!strcmp(uid, r->uid)) return true;
    say("Audio queue changed device. Expected %s, got %s.", r->uid, uid); return false;
}
static bool prepareQueue(Session *s, const Route *r) {
    UInt32 channels = r->input ? 1 : 2;
    UInt32 frames = r->input ? inputFrames : s->outputFrames;
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
    for (int i=0; i<QueueBuffers; ++i) {
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
- (void)contacts:(unsigned)mask swapped:(BOOL)swapped;
- (void)inputStep:(PaddleCalibrationStep)step sampling:(BOOL)sampling boosted:(BOOL)boosted profile:(const InputProfile *)profile;
@end
static void deliverContact(void *context, unsigned mask, bool swapped) {
    [(__bridge MorseEngine *)context contacts:mask swapped:swapped];
}
static void deliverInputStep(void *context, PaddleCalibrationStep step, bool sampling, bool boosted, const InputProfile *profile) {
    [(__bridge MorseEngine *)context inputStep:step sampling:sampling boosted:boosted profile:profile];
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
    TypingQueue _typing;
    SidetoneLevel _volume;
    atomic_bool _swapRequested;
    BOOL _swappedForPress;
    AtomicToneSettings _tone;
    NSUserDefaults *_preferences;
    NSArray<NSString *> *_inputDevices;
    atomic_uint _inputRequest;
}
- (instancetype)init { return [self initWithDefaults:NSUserDefaults.standardUserDefaults]; }
- (instancetype)initWithDefaults:(NSUserDefaults *)defaults {
    if ((self=[super init])) {
        _outputChoice=@"auto"; _workers=dispatch_group_create(); initTypingQueue(&_typing);
        atomic_init(&_volume.percent,100); atomic_init(&_volume.muted,false);
        atomic_init(&_inputRequest,NoInputRequest);
        _preferences=defaults;
        atomic_init(&_swapRequested,[defaults boolForKey:swapPreference]);
        NSDictionary *saved=[defaults dictionaryForKey:tonePreference];
        ToneSettings tone=defaultToneSettings;
        tone.pitchHz=(uint16_t)storedNumber(saved,@"pitchHz",tone.pitchHz,MinToneHz,MaxToneHz);
        tone.wpm=(uint8_t)storedNumber(saved,@"wpm",tone.wpm,MinKeyerWPM,MaxKeyerWPM);
        tone.riseMs=(uint8_t)storedNumber(saved,@"riseMs",tone.riseMs,MinRampMs,MaxRampMs);
        tone.fallMs=(uint8_t)storedNumber(saved,@"fallMs",tone.fallMs,MinRampMs,MaxRampMs);
        tone.curve=(uint8_t)storedNumber(saved,@"curve",tone.curve,RaisedCosine,ExponentialRamp);
        tone.spacingWpm=(uint8_t)storedNumber(saved,@"spacingWpm",MIN(tone.spacingWpm,tone.wpm),MinKeyerWPM,tone.wpm);
        tone.options=(uint8_t)storedNumber(saved,@"options",0,0,UseFarnsworth|TimedWordSpaces);
        atomic_init(&_tone,tone);
    }
    return self;
}
- (void)report:(NSString *)phase detail:(NSString *)detail mask:(unsigned)mask {
    if ([_phase isEqual:phase] && [_detail isEqual:detail] && _mask==mask) return;
    _phase=phase; _detail=detail; _mask=mask;
    double ms=paddleTimeMs();
    BOOL swapped=_swappedForPress;
    dispatch_async(dispatch_get_main_queue(),^{ if (self.stateChanged) self.stateChanged(phase,detail,mask,ms,swapped); });
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
    dispatch_async(dispatch_get_main_queue(),^{
        if (self.inputCalibrationChanged) self.inputCalibrationChanged(step,sampling,boosted);
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
            resetTypingSession(&_typing); beginCapture(d);
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
    t.spacingWpm=(uint8_t)bounded(t.spacingWpm,MinKeyerWPM,t.wpm);
    t.options &= UseFarnsworth|TimedWordSpaces;
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
    dispatch_async(dispatch_get_main_queue(),^{ if (self.outputsChanged) self.outputsChanged(items,text); });
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
    AudioDeviceID inputID=0, outputID=0;
    while (!self.stopping) @autoreleasepool {
        if (running) CFRunLoopRunInMode(kCFRunLoopDefaultMode,.024,false);
        else [NSThread sleepForTimeInterval:.05];
        double now=monotonicSeconds();
        InputRequest request=atomic_exchange(&_inputRequest,NoInputRequest);
        if (request!=NoInputRequest) [self handleInputRequest:request session:&s running:running];
        if (now<nextScan && !s.callbackError) continue;
        nextScan=now+.40;
        JackRoutes jack={0};
        NSArray<SoundOutput *> *options=scanOutputs(&jack);
        BOOL paired=jack.inputs==1 && jack.outputs==1;
        if (!reportedAdapter || paired!=lastPaired) {
            reportedAdapter=YES; lastPaired=paired;
            dispatch_async(dispatch_get_main_queue(),^{if (self.adapterConnectionChanged) self.adapterConnectionChanged(paired);});
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
            if (s.detector.step) [self inputStep:InputUnavailable sampling:NO boosted:NO profile:NULL];
            closeAudio(&s); running=NO; playingUID=nil; retryTone=0; retryAudio=now+.6;
            resetTypingSession(&_typing);
            [self report:@"disconnected" detail:@"Paddle disconnected" mask:0];
        }
        if (!paired) {
            NSString *message=jack.outputs==1 && !jack.inputs ? @"Plug fully into the jack · headset mic missing" :
                @"Connect the paddle adapter to the 3.5 mm jack";
            [self report:@"waiting" detail:message mask:0];
            [self reportOptions:options text:audioText]; continue;
        }
        if (!running) {
            AVAuthorizationStatus auth=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
            if (auth!=AVAuthorizationStatusAuthorized) {
                if (auth==AVAuthorizationStatusNotDetermined && !asked) {
                    asked=YES;
                    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL allow){ (void)allow; }];
                }
                [self report:@"permission" detail:auth==AVAuthorizationStatusNotDetermined ?
                    @"Allow microphone access to read the paddle" : @"Allow Morse Paddle under Privacy & Security → Microphone" mask:0];
                [self reportOptions:options text:audioText]; continue;
            }
            if (now<retryAudio) { [self reportOptions:options text:audioText]; continue; }
            s.inHz=deviceRate(&jack.input); s.outHz=deviceRate(&jack.output);
            prepareQuietKeyer(&s,&_typing,&_tone);
            makeTables(s.inHz); s.outputFrames=(UInt32)lround(s.outHz*.01);
            s.detector.context=(__bridge void *)self; s.detector.change=deliverContact;
            s.detector.swapRequested=&_swapRequested;
            s.detector.captureChanged=deliverInputStep;
            s.detector.profile=[self inputProfileForDevices:@[@(jack.input.uid),@(jack.output.uid)]];
            s.detector.waitForRelease=s.detector.profile.on[0]>0;
            s.generator.boosted=s.detector.profile.boosted;
            if (!prepareQueue(&s,&jack.input) || !prepareQueue(&s,&jack.output) ||
                !checked(AudioQueueStart(s.out,NULL),"Starting wired pilots") ||
                !checked(AudioQueueStart(s.in,NULL),"Starting headset return")) {
                closeAudio(&s); retryAudio=now+2; [self report:@"error" detail:@"Could not open the wired audio ports · retrying" mask:0];
                [self reportOptions:options text:audioText]; continue;
            }
            running=YES; s.lastIn=s.lastOut=monotonicSeconds();
            inputID=jack.input.dev; outputID=jack.output.dev;
            [self report:@"calibrating" detail:@"Calibrating · release both paddles" mask:0];
        }
        Route toneRoute=chosen ? chosen.route : (Route){0};
        if (s.speaker.unit && (![playingUID isEqual:chosen.uid] || !speakerSelected(&s.speaker,&toneRoute))) {
            s.detector.keyer=NULL; stopSpeaker(&s.speaker); playingUID=nil; retryTone=0;
            prepareQuietKeyer(&s,&_typing,&_tone);
        }
        if (chosen && !s.speaker.unit && now>=retryTone && toneRoute.dev!=outputID) {
            memset(&s.speaker,0,sizeof(s.speaker));
            if (startSpeaker(&s.speaker,&toneRoute,&_tone,&_typing,&_volume)) {
                playingUID=chosen.uid; s.detector.keyer=&s.speaker.keyer;
                setPaddles(s.detector.keyer,logicalContacts(&s.detector));
            } else retryTone=now+2;
        }
        if (chosen && !s.speaker.unit) audioText=[NSString stringWithFormat:@"Waiting to open %@",chosen.name];
        [self reportOptions:options text:audioText];
    }
    closeAudio(&s);
}
@end
