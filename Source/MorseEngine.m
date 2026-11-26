#import "MorseEngine.h"
#include "PaddleDSP.h"
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
