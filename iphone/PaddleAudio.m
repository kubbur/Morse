#import "PaddleAudio.h"
#import "Core.h"
#import "Sidetone.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#include <math.h>

typedef struct { unsigned tag; float peak[2]; } PilotBuffer;
enum { BufferCount = 3 };
enum { ReferenceCue = 0, CueCount = 3 };
static NSData *wave(NSArray *tones, NSDictionary *settings);
static NSString * const ReferencePlayback = @"reference-playback";
static NSString * const ReferenceMic = @"reference-mic";
typedef NS_ENUM(NSUInteger, ListeningStrategy) { StandardMultiroute, DualMultiroute, AddressedMultiroute, PlayAndRecord };
static NSString *strategyName(ListeningStrategy strategy) {
    return (@[@"wired-first multiroute", @"dual route", @"multiroute with saved output address", @"play and record"])[strategy];
}
typedef struct {
    PhoneCore *core;
    PhoneSignalMeter *meter;
    AudioQueueRef pilots, input, speaker;
    unsigned frames, inputChannels;
    bool detectContacts, clockFromInput;
    atomic_bool live;
    atomic_int fault, speakerFault;
    atomic_uint wantedTag, returnedTag;
    _Atomic(uint64_t) capturedFrames, toneFrames, silentFrames;
    _Atomic(uint64_t) returnedSidetoneFrames, returnedSidetoneBuffers;
    unsigned keyedFrames[BufferCount];
    PilotBuffer pilotBuffers[BufferCount];
    _Atomic(float) returnedTonePeak[2];
} PhoneIO;

static void queued(PhoneIO *io, AudioQueueRef queue, AudioQueueBufferRef b) {
    OSStatus result = AudioQueueEnqueueBuffer(queue, b, 0, NULL);
    if (result) {
        if (queue == io->speaker) atomic_store(&io->speakerFault, result);
        else atomic_store(&io->fault, result);
    }
}
static void fillOutput(PhoneIO *io, AudioQueueRef queue, AudioQueueBufferRef b) {
    if (queue == io->pilots) {
        unsigned tag = atomic_load(&io->wantedTag);
        if (tag & 1) phonePilots(io->core,b->mAudioData,io->frames);
        else memset(b->mAudioData,0,io->frames*2*sizeof(float));
        PilotBuffer *buffer = b->mUserData;
        buffer->tag = tag;
        if (io->meter && (tag & 1)) {
            const float *pcm = b->mAudioData;
            buffer->peak[0] = buffer->peak[1] = 0;
            for (unsigned i=0; i<io->frames; ++i)
                for (unsigned ch=0; ch<2; ++ch) buffer->peak[ch] = fmaxf(buffer->peak[ch],fabsf(*pcm++));
        }
    }
    else *(unsigned *)b->mUserData = phoneSpeaker(io->core, b->mAudioData, io->frames);
    b->mAudioDataByteSize = io->frames * sizeof(float) * (queue == io->pilots ? 2 : 1);
    queued(io, queue, b);
}
static void output(void *context, AudioQueueRef queue, AudioQueueBufferRef b) {
    PhoneIO *io = context;
    if (!atomic_load(&io->live)) return;
    if (queue == io->pilots) {
        // Count buffers returned by the running queue, excluding all initial fills.
        const PilotBuffer *buffer = b->mUserData;
        unsigned tag = buffer->tag;
        if (io->meter && (tag & 1))
            for (unsigned ch=0; ch<2; ++ch) atomic_store(&io->returnedTonePeak[ch],buffer->peak[ch]);
        atomic_fetch_add((tag & 1) ? &io->toneFrames : &io->silentFrames,io->frames);
        atomic_store(&io->returnedTag,tag);
    } else if (queue == io->speaker) {
        atomic_fetch_add(&io->returnedSidetoneFrames,*(unsigned *)b->mUserData);
        atomic_fetch_add(&io->returnedSidetoneBuffers,1);
    }
    fillOutput(io,queue,b);
}
static void input(void *context, AudioQueueRef q, AudioQueueBufferRef b, const AudioTimeStamp *stamp,
                  UInt32 packets, const AudioStreamPacketDescription *descriptions) {
    PhoneIO *io = context;
    if (!atomic_load(&io->live)) return;
    unsigned frames = b->mAudioDataByteSize / (sizeof(float)*io->inputChannels);
    if (io->meter) phoneMeterInput(io->meter,b->mAudioData,frames,atomic_load(&io->returnedTag));
    if (io->detectContacts) phoneInput(io->core,b->mAudioData,frames,io->inputChannels);
    if (io->clockFromInput) phoneClockKeyer(io->core,frames);
    atomic_fetch_add(&io->capturedFrames, frames);
    queued(io, q, b);
}
static void dispose(PhoneIO *io) {
    if (!io) return;
    atomic_store(&io->live, false);
    AudioQueueRef queues[] = {io->input,io->pilots,io->speaker};
    for (unsigned i=0; i<3; ++i) if (queues[i]) {
        AudioQueueStop(queues[i], true);
        AudioQueueDispose(queues[i], true);
    }
    phoneMeterDestroy(io->meter); phoneDestroy(io->core);
    free(io);
}
static OSStatus prepare(PhoneIO *io, AVAudioSessionPortDescription *port, unsigned channels,
                        double rate, AudioQueueRef *target, BOOL recording, NSNumber **assignmentStatus) {
    AudioStreamBasicDescription f = {.mSampleRate=rate, .mFormatID=kAudioFormatLinearPCM,
        .mFormatFlags=kAudioFormatFlagsNativeFloatPacked, .mChannelsPerFrame=channels,
        .mBitsPerChannel=32, .mFramesPerPacket=1, .mBytesPerFrame=4*channels, .mBytesPerPacket=4*channels};
    OSStatus code = recording ? AudioQueueNewInput(&f,input,io,NULL,NULL,0,target) :
                                AudioQueueNewOutput(&f,output,io,NULL,NULL,0,target);
    if (code) return code;
    if (io->meter) {
        AudioStreamBasicDescription actual = {0}; UInt32 size = sizeof(actual);
        code = AudioQueueGetProperty(*target,kAudioQueueProperty_StreamDescription,&actual,&size);
        if (code) return code;
        if (actual.mFormatID != f.mFormatID || actual.mChannelsPerFrame != channels ||
            actual.mBytesPerFrame != f.mBytesPerFrame || fabs(actual.mSampleRate-rate) > .5 ||
            !(actual.mFormatFlags & kAudioFormatFlagIsFloat) || (channels > 1 && (actual.mFormatFlags & kAudioFormatFlagIsNonInterleaved)))
            return kAudioFormatUnsupportedDataFormatError;
    }
    // In multiRoute, bind every queue to its own port. The contacts-only session
    // uses the default mapping only after verifying a single wired input and output.
    if (port) {
        AudioQueueChannelAssignment map[2] = {0};
        for (unsigned i=0; i<channels; ++i) {
            map[i].mDeviceUID = (__bridge CFStringRef)port.UID;
            map[i].mChannelNumber = i + 1;
        }
        code = AudioQueueSetProperty(*target,kAudioQueueProperty_ChannelAssignments,map,channels*sizeof(map[0]));
        if (assignmentStatus) *assignmentStatus = @(code);
    }
    for (unsigned i=0; i<BufferCount && !code; ++i) {
        AudioQueueBufferRef b = NULL;
        code = AudioQueueAllocateBuffer(*target, io->frames * f.mBytesPerFrame, &b);
        if (code) break;
        if (*target == io->pilots) b->mUserData = &io->pilotBuffers[i];
        if (*target == io->speaker) b->mUserData = &io->keyedFrames[i];
        if (recording) queued(io,*target,b); else fillOutput(io,*target,b);
        code = *target == io->speaker ? atomic_load(&io->speakerFault) : atomic_load(&io->fault);
    }
    return code;
}

static NSDictionary *portInfo(AVAudioSessionPortDescription *p) {
    return @{@"type":p.portType, @"name":p.portName, @"channels":@(p.channels.count)};
}
static NSArray *ports(NSArray<AVAudioSessionPortDescription *> *items) {
    NSMutableArray *result = [NSMutableArray array];
    for (AVAudioSessionPortDescription *p in items) [result addObject:portInfo(p)];
    return result;
}
static id dbFS(double level) {
    // Null denotes exactly zero. Keep small, nonzero returns distinct from silence.
    return level > 0 ? (id)@(round(200.0*log10(level))/10.0) : (id)NSNull.null;
}
static NSDictionary *signalReading(PhoneSignalReading reading, unsigned channels) {
    NSMutableArray *levels = [NSMutableArray array];
    for (unsigned ch=0; ch<channels; ++ch) {
        PhoneSignalLevel v = reading.channels[ch];
        [levels addObject:@{@"channel":@(ch+1),@"rmsDBFS":dbFS(v.rms),@"peakDBFS":dbFS(v.peak),
                            @"hz1000DBFS":dbFS(v.tone[0]),@"hz1600DBFS":dbFS(v.tone[1])}];
    }
    return @{@"framesPerChannel":@(reading.frames),@"endInputFrame":@(reading.endFrame),@"channels":levels};
}
static NSArray<NSString *> *signalPositions(void) { return @[@"released",@"left",@"right",@"both"]; }
static AVAudioSessionPortDescription *singlePort(NSArray<AVAudioSessionPortDescription *> *items,
                                                NSArray<NSString *> *types, NSUInteger minimum) {
    AVAudioSessionPortDescription *match = nil;
    for (AVAudioSessionPortDescription *p in items) if ([types containsObject:p.portType] && p.channels.count >= minimum) {
        if (match) return nil;
        match = p;
    }
    return match;
}
static NSString *routeKey(AVAudioSessionRouteDescription *route, double rate, unsigned bufferFrames) {
    NSMutableArray *parts = [@[@(rate), @(bufferFrames)] mutableCopy];
    for (NSArray *side in @[route.inputs,route.outputs]) {
        [parts addObject:@"|"];
        for (AVAudioSessionPortDescription *p in side)
            [parts addObject:@[p.UID,p.portType,[p.channels valueForKey:@"channelNumber"] ?: @[]]];
    }
    return parts.description;
}

static NSArray *wiredStreamKey(AVAudioSessionPortDescription *mic, AVAudioSessionPortDescription *jack,
                               double rate, unsigned frames) {
    if (!mic || !jack) return nil;
    return @[mic.UID, [mic.channels valueForKey:@"channelNumber"], jack.UID,
             [jack.channels valueForKey:@"channelNumber"], @(rate), @(frames)];
}

static NSMutableData *pcm16Wave(uint32_t rate, uint16_t channels, uint32_t frames) {
    uint16_t pcm=1, align=2*channels, bits=16;
    uint32_t bytes=frames*align, size=bytes+36, fmt=16, byteRate=rate*align;
    NSMutableData *data=[NSMutableData dataWithLength:44+bytes];
    unsigned char *header=data.mutableBytes;
    memcpy(header,"RIFF",4); memcpy(header+8,"WAVEfmt ",8); memcpy(header+36,"data",4);
    memcpy(header+4,&size,4); memcpy(header+16,&fmt,4); memcpy(header+20,&pcm,2);
    memcpy(header+22,&channels,2); memcpy(header+24,&rate,4); memcpy(header+28,&byteRate,4);
    memcpy(header+32,&align,2); memcpy(header+34,&bits,2); memcpy(header+40,&bytes,4);
    return data;
}
static NSData *paddlePilotWave(void) {
    static NSData *loop;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSMutableData *data=pcm16Wave(PhonePilotLoopRate,2,PhonePilotLoopRate);
        phonePilotLoopPCM16((int16_t *)((uint8_t *)data.mutableBytes+44));
        loop=data;
    });
    return loop;
}

@interface PaddleAudio () <AVAudioPlayerDelegate>
@end
@implementation PaddleAudio {
    PhoneIO *_io;
    BOOL _wanted, _foreground, _granted, _requesting, _interrupted, _configuredSession, _ready, _reverse, _mute;
    BOOL _contactsOnly, _hadWiredInput, _measuring;
    BOOL _systemProbe, _restoreRecordingSounds, _cueBusy;
    SystemSoundID _systemCues[CueCount];
    NSUInteger _cueSent[CueCount], _cueCompleted[CueCount], _cueWithInput[CueCount], _missedMarks;
    NSURL *_cueFolder;
    NSString *_cueError;
    BOOL _bluetoothOutput, _trialScheduled, _listeningProbe;
    ListeningStrategy _strategy;
    NSUInteger _trialGeneration;
    NSMutableArray *_routeAttempts;
    unsigned _session, _epoch, _sequence;
    NSString *_detail, *_routes, *_promptID;
    NSString *_requestedInputUID, *_inputRequest;
    NSDictionary *_previousSpeakerAttempt;
    NSString *_referenceMode;
    NSMutableDictionary *_referenceReadings;
    AVAudioPlayer *_wiredPlayer;
    NSTimeInterval _nextRouteCheck;
    NSTimeInterval _fallbackStarted, _trialBegan;
    NSString *_channelRequestRoute, *_channelRequest, *_capturePosition, *_captureNote;
    NSString *_inputFallback, *_outputIssue;
    NSDictionary *_liveReading, *_quietReading, *_freshCapture;
    NSMutableArray *_positionReadings;
    unsigned _captureTag, _captureAfter, _lastOrdinal;
    uint64_t _captureStartFrame;
    NSTimeInterval _captureStarted;
    NSDictionary *_sound;
    AVAudioSessionPortDescription *_speaker, *_listedSpeaker, *_rememberedSpeaker;
    NSArray *_wiredStream;
    NSDictionary *_outputAttempt;
    NSString *_rememberedIn;
    NSDictionary *_lastRouteChange;
    unsigned _contactStates;
    NSTimer *_timer;
    AVAudioPlayer *_prompt;
    PhoneReply _promptReply;
}
- (instancetype)init {
    if ((self = [super init])) {
        _foreground = YES;
        _detail = @"Select the audio converter to read the paddle.";
        NSNotificationCenter *n = NSNotificationCenter.defaultCenter;
        AVAudioSession *s = AVAudioSession.sharedInstance;
        [n addObserver:self selector:@selector(route:) name:AVAudioSessionRouteChangeNotification object:s];
        [n addObserver:self selector:@selector(interrupt:) name:AVAudioSessionInterruptionNotification object:s];
        [n addObserver:self selector:@selector(reset:) name:AVAudioSessionMediaServicesWereResetNotification object:s];
    }
    return self;
}
- (void)batch:(NSArray *)rows { if (self.publish && rows.count) self.publish(rows); }
- (NSString *)listeningDestination {
    return _bluetoothOutput ? (_speaker.portName ?: @"AirPods or Bluetooth headphones") : @"iPhone speaker";
}
- (NSDictionary *)status {
    BOOL listening = _io && _io->speaker && _wiredPlayer.isPlaying;
    return @{@"type":@"status",@"source":_wanted?(_referenceMode?@"reference":@"paddle"):@"off",
        @"phase":_ready?@"ready":_io?@"calibrating":@"waiting",@"outputReady":@(listening),
        @"output":listening?[self listeningDestination]:@"System output",@"sharedSound":@(listening),@"typing":@NO,
        @"hasReverse":@NO,@"reverse":@(_reverse),@"session":@(_session),@"epoch":@(_epoch),@"detail":_detail ?: @""};
}
- (NSDictionary *)routeReport {
    AVAudioSession *s = AVAudioSession.sharedInstance;
    AVAudioSessionRouteDescription *route = s.currentRoute;
    AVAudioSessionPortDescription *preferred = s.preferredInput;
    BOOL listening = _io && _io->speaker && _wiredPlayer.isPlaying;
    NSMutableArray *masks = [NSMutableArray array];
    for (unsigned mask = 0; mask < 4; ++mask)
        if (_contactStates & (1u << mask)) [masks addObject:@(mask)];
    return @{@"status":[self status],@"testMode":_systemProbe?@"system-speaker":_referenceMode?@"reference":_measuring?@"signal":_contactsOnly?@"contacts":_bluetoothOutput?@"airpods":@"speaker",
        @"routeStrategy":_systemProbe ? @"wired play and record with system sounds" : _contactsOnly ? @"wired diagnostic" : strategyName(_strategy),
        @"routesExhausted":@(_wanted && !_contactsOnly && _strategy == PlayAndRecord && !listening && (!_listedSpeaker || _outputAttempt)),
        @"canAdvanceRoute":@(_listeningProbe && _wanted && _configuredSession && _strategy != PlayAndRecord),
        @"wiredBaseline":@(_listeningProbe && _strategy == StandardMultiroute && _wiredStream && !_listedSpeaker && !_outputAttempt),
        @"contactStates":masks, @"outputAttempt":_outputAttempt ?: (id)NSNull.null,
        @"contactSignal":(_io && _io->detectContacts && _liveReading) ? _liveReading : (id)NSNull.null,
        @"learnedOutput":_rememberedSpeaker ? portInfo(_rememberedSpeaker) : (id)NSNull.null,
        @"sidetoneOutput":listening ? portInfo(_speaker) : (id)NSNull.null,
        @"sidetoneDestination":listening ? (_bluetoothOutput ? @"airpods" : @"speaker") : (id)NSNull.null,
        @"returnedSidetoneFrames":@(_io ? atomic_load(&_io->returnedSidetoneFrames) : 0),
        @"returnedSidetoneBuffers":@(_io ? atomic_load(&_io->returnedSidetoneBuffers) : 0),
        @"category":s.category,@"mode":s.mode,@"availableInputs":ports(s.availableInputs),
        @"preferredInput":preferred ? portInfo(preferred) : (id)NSNull.null,
        @"inputRequest":_inputRequest ?: @"No input request made.",
        @"inputs":ports(route.inputs),@"outputs":ports(route.outputs),
        @"rate":@(s.sampleRate),@"ioBufferSeconds":@(s.IOBufferDuration),
        @"queueBufferFrames":@(_io && (_io->pilots || _io->input || _io->speaker) ? _io->frames : 0),
        @"wiredOutputBuffers":@(_io && _io->pilots ? BufferCount : 0),
        @"contactPlayerRunning":@(!_referenceMode && _wiredPlayer.isPlaying),
        @"returnedWiredOutputFrames":@(_io ? atomic_load(&_io->toneFrames) + atomic_load(&_io->silentFrames) : 0),
        @"mask":@(_io ? phoneMask(_io->core) : 0),
        @"speakerActive":@(listening && [_speaker.UID isEqual:_listedSpeaker.UID] &&
            [_speaker.portType isEqual:AVAudioSessionPortBuiltInSpeaker]),
        @"capturedFrames":@(_io ? atomic_load(&_io->capturedFrames) : 0),
        @"audibleFrames":@(_io ? phoneAudibleFrames(_io->core) : 0),@"active":@(_io != NULL)};
}
- (void)saveReferenceReading {
    if (!_referenceMode || !_wanted || !_foreground || _interrupted) return;
    AVAudioSession *s = AVAudioSession.sharedInstance;
    AVAudioSessionRouteDescription *route = s.currentRoute;
    _referenceReadings[_referenceMode] = @{
        @"time":@([NSDate date].timeIntervalSince1970), @"category":s.category, @"mode":s.mode,
        @"inputs":ports(route.inputs), @"outputs":ports(route.outputs), @"systemOutputVolume":@(s.outputVolume),
        @"rate":@(s.sampleRate), @"ioBufferSeconds":@(s.IOBufferDuration),
        @"hardwareOutputChannels":@(s.outputNumberOfChannels), @"sessionActive":@(_configuredSession),
        @"playerRunning":@(_wiredPlayer.isPlaying), @"capturedFrames":@(_io ? atomic_load(&_io->capturedFrames) : 0),
        @"detail":_detail ?: @""};
}
- (NSDictionary *)snapshot {
    // An available mic can appear before iOS changes the active route.
    if (_configuredSession && (!_contactsOnly || !_io || _measuring || _referenceMode) &&
        NSProcessInfo.processInfo.systemUptime >= _nextRouteCheck) [self openRoute];
    NSMutableDictionary *report = [[self routeReport] mutableCopy];
    report[@"build"] = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @"";
    report[@"canTestContacts"] = @(_wanted && _granted && _foreground && !_interrupted && !_io && !_contactsOnly);
    if (_previousSpeakerAttempt) report[@"previousSpeakerAttempt"] = _previousSpeakerAttempt;
    if (_routeAttempts.count) report[@"routeAttempts"] = [_routeAttempts copy];
    if (_lastRouteChange) report[@"lastRouteChange"] = _lastRouteChange;
    if (_systemProbe) {
        NSMutableDictionary *cues = [NSMutableDictionary dictionary];
        NSArray *names = @[@"reference", @"dit", @"dah"];
        for (NSUInteger i=0; i<CueCount; ++i) {
            cues[names[i]] = @{@"requested":@(_cueSent[i]), @"completed":@(_cueCompleted[i]),
                               @"completedDuringCapture":@(_cueWithInput[i])};
        }
        report[@"systemSound"] = @{@"cues":cues, @"ready":@(_systemCues[PhoneDah] != 0 && !_cueError),
            @"allowedDuringRecording":@(AVAudioSession.sharedInstance.allowHapticsAndSystemSoundsDuringRecording),
            @"busy":@(_cueBusy), @"missedMarks":@(_missedMarks), @"error":_cueError ?: @"",
            @"wpm":@(PhoneProbeWPM), @"pitchHz":@(PhoneProbePitch)};
    }
    if (_referenceMode) {
        [self saveReferenceReading];
        report[@"jackComparison"] = @{@"phase":_referenceMode, @"stopped":@(!_wanted),
            @"frequencyHz":@1000, @"peakDBFS":@(-18), @"channel":@"left", @"phases":[_referenceReadings copy]};
    }
    if (_measuring) {
        AVAudioSession *s = AVAudioSession.sharedInstance;
        unsigned returned = _io ? atomic_load(&_io->returnedTag) : 0;
        report[@"jackAudio"] = @{@"hardwareInputChannels":@(s.inputNumberOfChannels),
            @"hardwareOutputChannels":@(s.outputNumberOfChannels),@"queueInputChannels":@(_io ? _io->inputChannels : 0),
            @"channelRequest":_channelRequest ?: @"",@"inputFallback":_inputFallback ?: @"",
            @"outputIssue":_outputIssue ?: @"",@"systemOutputVolume":@(s.outputVolume),
            @"wiredOutputQueue":@(_io && _io->pilots),@"leftOutputHz":@1000,@"rightOutputHz":@1600,
            @"lastReturnedBuffer":returned ? ((returned & 1) ? @"tones" : @"silence") : @"none",
            @"toneFramesReturned":@(_io ? atomic_load(&_io->toneFrames) : 0),
            @"silentFramesReturned":@(_io ? atomic_load(&_io->silentFrames) : 0),
            @"returnedTonePeakDBFS":@[dbFS(_io ? atomic_load(&_io->returnedTonePeak[0]) : 0),
                                      dbFS(_io ? atomic_load(&_io->returnedTonePeak[1]) : 0)],
            @"live":_liveReading ?: (id)NSNull.null,@"measurements":[_positionReadings copy] ?: @[],
            @"measuringPosition":_capturePosition ?: @"",@"note":_captureNote ?: @""};
    }
    return report;
}
- (void)prepareSystemCues {
    NSFileManager *files = NSFileManager.defaultManager;
    _cueFolder = [files.temporaryDirectory URLByAppendingPathComponent:NSUUID.UUID.UUIDString isDirectory:YES];
    NSError *error = nil;
    if (![files createDirectoryAtURL:_cueFolder withIntermediateDirectories:NO attributes:nil error:&error]) {
        _cueError = error.localizedDescription; return;
    }
    double dot = 1.2 / PhoneProbeWPM;
    const double duration[CueCount] = {.45, dot, 3*dot};
    for (unsigned i=0; i<CueCount; ++i) {
        NSURL *url = [_cueFolder URLByAppendingPathComponent:[NSString stringWithFormat:@"%u.wav",i]];
        NSDictionary *settings = @{@"tone":@(i == ReferenceCue ? 900 : PhoneProbePitch), @"volume":@100, @"rise":@5, @"fall":@5};
        NSData *pcm = wave(@[@{@"start":@0, @"duration":@(duration[i])}],settings);
        if (![pcm writeToURL:url options:NSDataWritingAtomic error:&error]) {
            _cueError = error.localizedDescription ?: @"Could not write the speaker cue."; return;
        }
        OSStatus code = AudioServicesCreateSystemSoundID((__bridge CFURLRef)url,&_systemCues[i]);
        if (code) { _cueError = [NSString stringWithFormat:@"Could not load the system sound (%d).",(int)code]; return; }
    }
}
- (BOOL)playSystemCue:(unsigned)cue {
    if (!_systemProbe || !_foreground || !_configuredSession || _interrupted || _cueError ||
        cue >= CueCount || !_systemCues[cue] || !AVAudioSession.sharedInstance.allowHapticsAndSystemSoundsDuringRecording) return NO;
    if (_cueBusy) { if (cue != ReferenceCue) ++_missedMarks; return NO; }
    BOOL capture = _io && _io->clockFromInput && _ready && _wiredPlayer.isPlaying;
    if (cue != ReferenceCue && (!capture || _mute)) return NO;
    uint64_t start = capture ? atomic_load(&_io->capturedFrames) : 0;
    unsigned session = _session, epoch = _epoch;
    _cueBusy = YES;
    ++_cueSent[cue];
    __weak PaddleAudio *weak = self;
    AudioServicesPlaySystemSoundWithCompletion(_systemCues[cue], ^{
        dispatch_async(dispatch_get_main_queue(), ^{
            PaddleAudio *audio = weak;
            if (!audio || audio->_session != session) return;
            audio->_cueBusy = NO;
            if (audio->_epoch != epoch) return;
            ++audio->_cueCompleted[cue];
            if (start && audio->_io && audio->_wiredPlayer.isPlaying && audio->_ready &&
                atomic_load(&audio->_io->capturedFrames) > start) ++audio->_cueWithInput[cue];
        });
    });
    return YES;
}
- (void)clearSystemCues {
    for (unsigned i=0; i<CueCount; ++i) {
        if (_systemCues[i]) AudioServicesDisposeSystemSoundID(_systemCues[i]);
        _systemCues[i] = 0;
        _cueSent[i] = _cueCompleted[i] = _cueWithInput[i] = 0;
    }
    if (_cueFolder) [NSFileManager.defaultManager removeItemAtURL:_cueFolder error:nil];
    _cueFolder = nil; _cueError = nil; _cueBusy = NO; _missedMarks = 0;
}
- (void)clearIO {
    [self clearSystemCues];
    [self stopPrompt:nil];
    [_wiredPlayer stop]; _wiredPlayer = nil;
    [_timer invalidate]; _timer = nil;
    dispose(_io); _io = NULL; _speaker = nil; _ready = NO;
    _listedSpeaker = nil; _wiredStream = nil; _outputAttempt = nil; _contactStates = 0;
    _liveReading = _quietReading = _freshCapture = nil; _positionReadings = nil; _capturePosition = _captureNote = nil;
    _inputFallback = _outputIssue = nil; _lastOrdinal = 0;
    _routes = nil; _epoch = 0; ++_session;
    [self batch:@[@{@"type":@"reset"}]];
}
- (void)deactivate {
    ++_trialGeneration; _trialScheduled = NO;
    [self clearIO];
    if (_configuredSession) {
        _configuredSession = NO;
        AVAudioSession *s = AVAudioSession.sharedInstance;
        if (_requestedInputUID && [s.preferredInput.UID isEqual:_requestedInputUID]) [s setPreferredInput:nil error:nil];
        [s setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    }
    if (_restoreRecordingSounds) {
        [AVAudioSession.sharedInstance setAllowHapticsAndSystemSoundsDuringRecording:NO error:nil];
        _restoreRecordingSounds = NO;
    }
    _requestedInputUID = nil; _inputRequest = nil; _hadWiredInput = NO;
    _channelRequestRoute = _channelRequest = nil;
    [self batch:@[[self status]]];
}
- (void)applySound {
    if (!_io) return;
    if (_systemProbe || _listeningProbe) phoneSound(_io->core,PhoneProbeWPM,PhoneProbeWPM,PhoneProbePitch,100,5,5,RaisedCosine,false);
    else if (_sound) phoneSound(_io->core, [_sound[@"wpm"] unsignedIntValue], [_sound[@"farnsworth"] unsignedIntValue],
        [_sound[@"pitch"] unsignedIntValue], [_sound[@"volume"] unsignedIntValue], [_sound[@"rise"] unsignedIntValue],
        [_sound[@"fall"] unsignedIntValue], [_sound[@"curve"] unsignedIntValue], [_sound[@"keyer"] isEqual:@"b"]);
    phoneMute(_io->core,_mute);
    phoneReverse(_io->core,_reverse);
}
- (void)requestWiredInput:(AVAudioSession *)s types:(NSArray<NSString *> *)types {
    AVAudioSessionPortDescription *active = singlePort(s.currentRoute.inputs,types,1);
    if (active) {
        _hadWiredInput = YES;
        _inputRequest = [active.UID isEqual:_requestedInputUID] ? @"iOS activated the requested wired microphone."
                                                               : @"Wired microphone is active.";
        return;
    }
    if (_hadWiredInput) { _hadWiredInput = NO; _requestedInputUID = nil; }
    // Inactive ports can have zero channel descriptions until iOS selects them.
    AVAudioSessionPortDescription *candidate = singlePort(s.availableInputs,types,0);
    if (!candidate) {
        _requestedInputUID = nil; _inputRequest = @"No unique wired microphone is available to request."; return;
    }
    if ([_requestedInputUID isEqual:candidate.UID]) return;
    if (_io) {
        if (_listeningProbe) [self recordRouteAttempt:@"Wired input changed"];
        [self clearIO];
    }
    _requestedInputUID = [candidate.UID copy];
    NSError *error = nil;
    if ([s setPreferredInput:candidate error:&error]) _inputRequest = @"Requested the wired microphone.";
    else _inputRequest = [NSString stringWithFormat:@"Wired microphone request failed (%ld): %@",
                          (long)error.code,error.localizedDescription ?: @"Unknown error"];
}
- (void)requestProbeChannels:(AVAudioSession *)s types:(NSArray<NSString *> *)types {
    AVAudioSessionRouteDescription *route = s.currentRoute;
    AVAudioSessionPortDescription *mic = singlePort(route.inputs,types,1);
    if (!mic || route.inputs.count != 1) { _channelRequestRoute = _channelRequest = nil; return; }
    AVAudioSessionPortDescription *wire = singlePort(route.outputs,@[AVAudioSessionPortHeadphones,AVAudioSessionPortUSBAudio],1);
    NSString *key = [NSString stringWithFormat:@"%@|%@|%ld|%ld",mic.UID,wire.UID ?: @"",
                     (long)s.maximumInputNumberOfChannels,(long)s.maximumOutputNumberOfChannels];
    if ([_channelRequestRoute isEqual:key]) return;
    _channelRequestRoute = key;
    NSMutableArray *notes = [NSMutableArray array];
    NSError *error = nil;
    if (s.inputNumberOfChannels < 2 && s.maximumInputNumberOfChannels >= 2)
        [notes addObject:[s setPreferredInputNumberOfChannels:2 error:&error] ? @"Requested two input channels." :
                         (error.localizedDescription ?: @"Stereo input request failed.")];
    if (wire && route.outputs.count == 1 && s.outputNumberOfChannels < 2 && s.maximumOutputNumberOfChannels >= 2)
        [notes addObject:[s setPreferredOutputNumberOfChannels:2 error:&error] ? @"Requested two output channels." :
                         (error.localizedDescription ?: @"Stereo output request failed.")];
    _channelRequest = [notes componentsJoinedByString:@" "];
}
- (OSStatus)startMeterQueues:(PhoneIO *)io rate:(double)rate drive:(BOOL)drive {
    OSStatus code;
    for (;;) {
        io->meter = phoneMeterCreate(io->inputChannels);
        if (!io->meter) return kAudio_MemFullError;
        code = prepare(io,nil,io->inputChannels,rate,&io->input,YES,NULL);
        if (!code || io->inputChannels == 1) break;
        _inputFallback = [NSString stringWithFormat:@"iOS rejected stereo capture (%d). Reading mono.",(int)code];
        if (io->input) { AudioQueueDispose(io->input,true); io->input = NULL; }
        atomic_store(&io->fault,0);
        phoneMeterDestroy(io->meter); io->meter = NULL; io->inputChannels = 1;
    }
    if (code) return code;
    if (drive) {
        code = prepare(io,nil,2,rate,&io->pilots,NO,NULL);
        if (!code) code = AudioQueueStart(io->pilots,NULL);
        if (code) {
            _outputIssue = [NSString stringWithFormat:@"Could not start wired stereo output (%d).",(int)code];
            if (io->pilots) { AudioQueueDispose(io->pilots,true); io->pilots = NULL; }
            atomic_store(&io->fault,0);
        }
    } else _outputIssue = @"The current route has no isolated stereo wired output.";
    return AudioQueueStart(io->input,NULL);
}
- (NSString *)startWiredPlayer:(PhoneIO *)io rate:(double)rate
                    microphone:(AVAudioSessionPortDescription *)mic wiredOutput:(AVAudioSessionPortDescription *)wire {
    if (![_referenceMode isEqual:ReferencePlayback]) {
        AVAudioSession *s = AVAudioSession.sharedInstance;
        io->frames = (unsigned)ceil(rate * MAX(.025, s.IOBufferDuration));
        io->inputChannels = mic ? (unsigned)MIN(2,mic.channels.count) : (unsigned)MAX(1, MIN(2, s.inputNumberOfChannels));
        if (io->detectContacts && !(io->meter = phoneMeterCreate(io->inputChannels))) return @"Could not open the contact signal meter.";
        OSStatus code = prepare(io,mic,io->inputChannels,rate,&io->input,YES,NULL);
        if (!code) code = AudioQueueStart(io->input,NULL);
        if (code && mic && s.currentRoute.inputs.count == 1 && [s.currentRoute.inputs.firstObject.UID isEqual:mic.UID]) {
            // Some adapters reject queue channel assignments even as the sole active input.
            _inputFallback = [NSString stringWithFormat:@"Wired channel assignment or start failed (%d). Using the sole wired input.",(int)code];
            if (io->input) { AudioQueueDispose(io->input,true); io->input = NULL; }
            atomic_store(&io->fault,0);
            code = prepare(io,nil,io->inputChannels,rate,&io->input,YES,NULL);
            if (!code) code = AudioQueueStart(io->input,NULL);
        }
        if (code) return [NSString stringWithFormat:@"Could not start wired microphone capture (%d).",(int)code];
    }
    NSError *error = nil;
    if (_referenceMode) {
        NSURL *url = [NSBundle.mainBundle URLForResource:@"JackReference" withExtension:@"wav"];
        if (!url) return @"The reference waveform is missing.";
        _wiredPlayer = [[AVAudioPlayer alloc] initWithContentsOfURL:url error:&error];
    } else {
        _wiredPlayer = [[AVAudioPlayer alloc] initWithData:paddlePilotWave() error:&error];
    }
    if (!_wiredPlayer) return error.localizedDescription ?: @"Could not open the wired test tones.";
    if (wire) {
        if (wire.channels.count < 2 || _wiredPlayer.numberOfChannels != 2)
            return @"The wired player needs separate left and right channels.";
        _wiredPlayer.channelAssignments = [wire.channels subarrayWithRange:NSMakeRange(0,2)];
    }
    _wiredPlayer.numberOfLoops = -1;
    _wiredPlayer.volume = 1;
    if (![_wiredPlayer prepareToPlay] || ![_wiredPlayer play]) return @"iOS could not start wired playback.";
    return nil;
}
- (void)attachListeningOutput {
    if (_contactsOnly || !_io || _io->speaker || _outputAttempt || !_ready || !_wiredPlayer.isPlaying) return;
    AVAudioSessionPortDescription *target = _listedSpeaker;
    if (!target && _strategy == AddressedMultiroute) target = _rememberedSpeaker;
    if (!target) return;
    uint64_t before = atomic_load(&_io->capturedFrames);
    if (!before) return;
    AVAudioSessionRouteDescription *beforeRoute = AVAudioSession.sharedInstance.currentRoute;
    // Discard contacts held or queued before the output was attached. Only this
    // queue renders the keyer and produces the trainer's timestamped elements.
    phoneInvalidate(_io->core);
    _contactStates = 0;
    NSNumber *assignment = nil, *start = nil;
    OSStatus code = prepare(_io,target,1,AVAudioSession.sharedInstance.sampleRate,&_io->speaker,NO,&assignment);
    OSStatus prepared = code;
    if (!code) { code = AudioQueueStart(_io->speaker,NULL); start = @(code); }
    _outputAttempt = @{@"target":portInfo(target), @"listedWhenAddressed":@(_listedSpeaker != nil),
        @"addressObservedIn":_listedSpeaker ? strategyName(_strategy) : _rememberedIn,
        @"inputFramesBefore":@(before), @"pilotsPlayingBefore":@(_wiredPlayer.isPlaying),
        @"inputsBefore":ports(beforeRoute.inputs), @"outputsBefore":ports(beforeRoute.outputs),
        @"assignmentStatus":assignment ?: (id)NSNull.null, @"prepareStatus":@(prepared),
        @"startStatus":start ?: (id)NSNull.null};
    if (code) {
        if (_io->speaker) { AudioQueueDispose(_io->speaker,true); _io->speaker = NULL; }
        atomic_store(&_io->speakerFault,0);
        _detail = [NSString stringWithFormat:@"Wired capture is running. iOS rejected the sidetone queue (%d).",(int)code];
    } else {
        _speaker = target;
        _detail = [NSString stringWithFormat:@"Sidetone requested on %@. Release both paddles, then follow the prompts.",[self listeningDestination]];
    }
    [self batch:@[[self status]]];
}
- (void)openRoute {
    BOOL playbackOnly = [_referenceMode isEqual:ReferencePlayback];
    if (!_foreground || _interrupted || !_wanted || (!playbackOnly && !_granted)) return;
    _nextRouteCheck = NSProcessInfo.processInfo.systemUptime + 1.;
    AVAudioSession *s = AVAudioSession.sharedInstance;
    NSError *error = nil;
    if (!_configuredSession) {
        BOOL multi = !_contactsOnly && _strategy != PlayAndRecord;
        BOOL dual = multi && _strategy == DualMultiroute;
        AVAudioSessionCategory category = multi ? AVAudioSessionCategoryMultiRoute : AVAudioSessionCategoryPlayAndRecord;
        if (playbackOnly) category = AVAudioSessionCategoryPlayback;
        AVAudioSessionMode mode = dual ? AVAudioSessionModeDualRoute : AVAudioSessionModeDefault;
        AVAudioSessionCategoryOptions options = dual ? AVAudioSessionCategoryOptionAllowBluetoothHFP : 0;
        if (!_contactsOnly && !multi && _bluetoothOutput) options = AVAudioSessionCategoryOptionAllowBluetoothA2DP;
        BOOL configured = [s setCategory:category mode:mode options:options error:&error];
        if (configured && _systemProbe && !s.allowHapticsAndSystemSoundsDuringRecording) {
            configured = [s setAllowHapticsAndSystemSoundsDuringRecording:YES error:&error];
            _restoreRecordingSounds = configured;
        }
        if (!configured || ![s setActive:YES error:&error]) {
            _detail = error.localizedDescription ?: @"iOS could not activate the audio session.";
            [self batch:@[[self status]]]; return;
        }
        _configuredSession = YES;
        _trialBegan = NSProcessInfo.processInfo.systemUptime;
    }
    NSArray *inputTypes = @[AVAudioSessionPortHeadsetMic,AVAudioSessionPortUSBAudio];
    if (!playbackOnly) [self requestWiredInput:s types:inputTypes];
    if (_measuring) [self requestProbeChannels:s types:inputTypes];
    AVAudioSessionRouteDescription *route = s.currentRoute;
    double rate = s.sampleRate;
    unsigned bufferFrames = phoneQueueFrames(rate,s.IOBufferDuration);
    NSString *key = routeKey(route,rate,bufferFrames);
    key = [key stringByAppendingFormat:@"|%ld|%ld",(long)s.inputNumberOfChannels,(long)s.outputNumberOfChannels];
    AVAudioSessionPortDescription *mic = singlePort(route.inputs,inputTypes,1);
    AVAudioSessionPortDescription *wire = singlePort(route.outputs,@[AVAudioSessionPortHeadphones,AVAudioSessionPortUSBAudio],2);
    NSArray *listenTypes = _bluetoothOutput ? @[AVAudioSessionPortBluetoothA2DP, AVAudioSessionPortBluetoothHFP, AVAudioSessionPortBluetoothLE] :
                                               @[AVAudioSessionPortBuiltInSpeaker];
    AVAudioSessionPortDescription *listed = _contactsOnly ? nil : singlePort(route.outputs,listenTypes,1);
    if (listed) { _rememberedSpeaker = listed; _rememberedIn = strategyName(_strategy); }
    if ([_routes isEqual:key]) return;
    BOOL pinWires = !_contactsOnly && mic && wire && (_strategy != PlayAndRecord || listed);
    NSArray *wires = pinWires ? wiredStreamKey(mic,wire,rate,bufferFrames) : nil;
    // Adding a listening port must not tear down working microphone and pilot streams.
    BOOL sameInput = !_inputFallback || (route.inputs.count == 1 && [route.inputs.firstObject.UID isEqual:mic.UID]);
    if (_io && !_io->speaker && wires && [_wiredStream isEqual:wires] && sameInput && _wiredPlayer.isPlaying) {
        _routes = key; _listedSpeaker = listed; _outputAttempt = nil;
        [self attachListeningOutput]; return;
    }
    if (_listeningProbe && _io && (_outputAttempt || _contactStates))
        [self recordRouteAttempt:@"Active route changed"];
    [self clearIO]; _routes = key; _listedSpeaker = listed;
    if (_systemProbe) [self prepareSystemCues];
    BOOL combined = mic && wire && listed;
    // After trying both multiroute modes, keep the proven isolated wired path live if available.
    BOOL wiredFallback = !_contactsOnly && _strategy == PlayAndRecord && !combined;
    NSString *waiting = nil;
    if ((_contactsOnly && !_measuring) || wiredFallback) {
        if (route.outputs.count != 1 || !singlePort(route.outputs,@[AVAudioSessionPortHeadphones,AVAudioSessionPortUSBAudio],0))
            waiting = @"Waiting for iOS to select the wired output. See the active route below.";
        else if (!playbackOnly && (route.inputs.count != 1 || !singlePort(route.inputs,inputTypes,0)))
            waiting = @"Waiting for iOS to select the wired microphone. See the active route below.";
        else if (!_referenceMode && s.outputNumberOfChannels == 1)
            waiting = @"The paddle needs two wired output channels for its sensing tones.";
    }
    else if (!mic) waiting = @"Waiting for iOS to activate the wired microphone.";
    else if (_measuring) {
        if (route.inputs.count != 1 || s.inputNumberOfChannels < 1) waiting = @"Waiting for the wired input channel.";
    }
    else if (!wire) waiting = @"Waiting for two wired output channels for the paddle sensing tones.";
    if (waiting) {
        _detail = waiting;
        [self batch:@[[self status]]]; return;
    }
    PhoneIO *io = calloc(1,sizeof(*io));
    if (!io || !(io->core = phoneCreate(rate))) {
        free(io); _detail = @"The reported audio sample rate or buffer allocation is unavailable.";
        [self batch:@[[self status]]]; return;
    }
    _io = io; [self applySound];
    io->detectContacts = !_referenceMode && !_measuring;
    io->clockFromInput = _systemProbe;
    io->frames = bufferFrames;
    io->inputChannels = _measuring ? (unsigned)MIN((NSInteger)MIN((NSUInteger)2,mic.channels.count),s.inputNumberOfChannels) : 1;
    atomic_init(&io->live, true);
    atomic_init(&io->fault, 0);
    atomic_init(&io->speakerFault, 0);
    atomic_init(&io->capturedFrames, 0);
    atomic_init(&io->wantedTag,1); atomic_init(&io->returnedTag,0);
    atomic_init(&io->toneFrames,0); atomic_init(&io->silentFrames,0);
    atomic_init(&io->returnedSidetoneFrames,0); atomic_init(&io->returnedSidetoneBuffers,0);
    for (unsigned ch=0; ch<2; ++ch) atomic_init(&io->returnedTonePeak[ch],0);
    OSStatus code = noErr;
    NSString *operation = nil;
    if (!_measuring) {
        // Start capture before playback, as in the contact test. Bind each stream when sharing a route.
        NSString *failure = [self startWiredPlayer:io rate:rate microphone:pinWires ? mic : nil wiredOutput:pinWires ? wire : nil];
        if (failure) {
            [self clearIO]; _routes = key; _detail = failure;
            [self batch:@[[self status]]]; return;
        }
        _wiredStream = wires;
    } else {
        operation = @"open the wired input meter";
        _positionReadings = [NSMutableArray array];
        code = [self startMeterQueues:io rate:rate drive:(wire && route.outputs.count == 1 && s.outputNumberOfChannels >= 2)];
    }
    if (code) {
        [self clearIO]; _routes = key;
        _detail = [NSString stringWithFormat:@"Could not %@ (OSStatus %d).",operation,(int)code];
        [self batch:@[[self status]]]; return;
    }
    if (_referenceMode) _detail = playbackOnly ? @"Playing the reference tone." : @"Waiting for wired microphone samples.";
    else _detail = _measuring ? @"Waiting for input samples." : @"Calibrating. Release both paddles.";
    [self batch:@[[self status]]];
    _timer = [NSTimer timerWithTimeInterval:.025 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
    [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
}
- (void)recordRouteAttempt:(NSString *)reason {
    NSDictionary *snapshot = [self routeReport];
    NSMutableDictionary *row = [[snapshot dictionaryWithValuesForKeys:@[
        @"routeStrategy",@"mode",@"category",@"inputs",@"outputs",@"learnedOutput",@"inputRequest",
        @"capturedFrames",@"contactPlayerRunning",@"contactStates",@"contactSignal",@"outputAttempt",
        @"returnedSidetoneBuffers",@"returnedSidetoneFrames"]] mutableCopy];
    row[@"detail"] = _detail ?: @"";
    row[@"endedBy"] = reason;
    row[@"time"] = @(NSDate.date.timeIntervalSince1970);
    if (_inputFallback) row[@"inputFallback"] = _inputFallback;
    if (_routeAttempts.count >= 6) [_routeAttempts removeObjectAtIndex:0];
    [_routeAttempts addObject:row];
}
- (void)advanceStrategy:(NSString *)reason {
    if (_contactsOnly || _strategy == PlayAndRecord) return;
    [self recordRouteAttempt:reason];
    ListeningStrategy next = PlayAndRecord;
    if (_strategy == StandardMultiroute) next = DualMultiroute;
    else if (_strategy == DualMultiroute && _rememberedSpeaker &&
             (_listeningProbe || [_rememberedSpeaker.UID isEqual:[NSUserDefaults.standardUserDefaults stringForKey:@"verified-direct-paddle-uid"]]))
        next = AddressedMultiroute;
    [self deactivate];
    _strategy = next;
    if (next == PlayAndRecord) _fallbackStarted = NSProcessInfo.processInfo.systemUptime;
    [self start];
}
- (void)scheduleNextStrategy {
    if (_contactsOnly || _strategy == PlayAndRecord || _trialScheduled) return;
    NSUInteger generation = _trialGeneration;
    _trialScheduled = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (self->_trialGeneration != generation) return;
        self->_trialScheduled = NO;
        if (!self->_wanted || !self->_foreground || self->_interrupted || self->_contactsOnly) return;
        if (self->_configuredSession) [self openRoute];
        PhoneIO *io = self->_io;
        if (io && io->speaker && self->_wiredPlayer.isPlaying && atomic_load(&io->capturedFrames)
            && atomic_load(&io->returnedSidetoneBuffers)) return;
        if (io && self->_wiredPlayer.isPlaying && !self->_outputAttempt) {
            // Leave the first live pair open for the user's baseline contact sequence.
            if (self->_listeningProbe && self->_strategy == StandardMultiroute && self->_ready &&
                !self->_listedSpeaker) return;
            if (!self->_ready && NSProcessInfo.processInfo.systemUptime - self->_trialBegan < 9.) {
                [self scheduleNextStrategy]; return;
            }
        }
        [self advanceStrategy:@"Automatic route check"];
    });
}
- (void)start {
    if (!_wanted || !_foreground || _interrupted) return;
    if (_granted || [_referenceMode isEqual:ReferencePlayback]) {
        [self openRoute]; [self scheduleNextStrategy]; return;
    }
    if (_requesting) return;
    _requesting = YES;
    [AVAudioApplication requestRecordPermissionWithCompletionHandler:^(BOOL allowed) {
        dispatch_async(dispatch_get_main_queue(), ^{
            self->_requesting = NO; self->_granted = allowed;
            if (!self->_wanted || !self->_foreground || self->_interrupted) return;
            if (allowed || [self->_referenceMode isEqual:ReferencePlayback]) [self start];
            else { self->_detail = @"Allow microphone access for Morse in Settings."; [self batch:@[[self status]]]; }
        });
    }];
}
- (void)finishMeasurement:(NSDictionary *)fields {
    NSMutableDictionary *entry = [fields mutableCopy];
    entry[@"position"] = _capturePosition;
    entry[@"systemOutputVolume"] = @(AVAudioSession.sharedInstance.outputVolume);
    [_positionReadings addObject:entry];
    _capturePosition = nil; _quietReading = _freshCapture = nil;
}
- (void)updateMeter {
    PhoneSignalReading r;
    while (phoneMeterRead(_io->meter,&r)) {
        _lastOrdinal = r.ordinal;
        _liveReading = signalReading(r,_io->inputChannels);
        if (!_ready) {
            _ready = YES; _detail = @"Reading all audio on the wired input.";
            [self batch:@[[self status]]];
        }
        if (!_capturePosition) continue;
        if (r.endFrame < _captureStartFrame + r.frames) continue;
        _freshCapture = _liveReading;
        if (r.outputTag != _captureTag || r.ordinal < _captureAfter) continue;
        if (!_io->pilots) {
            [self finishMeasurement:@{@"inputOnly":_liveReading}];
        } else if (!(_captureTag & 1)) {
            _quietReading = _liveReading;
            atomic_store(&_io->wantedTag,++_captureTag);
        } else {
            [self finishMeasurement:@{@"tonesOff":_quietReading,@"tonesOn":_liveReading}];
        }
    }
    if (_capturePosition && NSProcessInfo.processInfo.systemUptime - _captureStarted > 4.) {
        atomic_store(&_io->wantedTag,atomic_load(&_io->wantedTag) | 1u);
        if (_freshCapture) {
            NSMutableDictionary *fields = [@{@"inputOnly":_freshCapture,@"outputComparison":@"Output change unconfirmed."} mutableCopy];
            if (_quietReading) fields[@"tonesOff"] = _quietReading;
            [self finishMeasurement:fields];
            _captureNote = @"Input measured. The output queue did not confirm both phases.";
        } else {
            _capturePosition = nil; _quietReading = nil;
            _captureNote = @"No fresh input samples arrived. Tap to retry.";
        }
    }
}
- (NSDictionary *)markSignal:(id)value {
    if (!_measuring || !_io || !_io->meter || !_liveReading || _capturePosition ||
        ![value isKindOfClass:NSDictionary.class] || [value[@"session"] unsignedIntegerValue] != _session ||
        _positionReadings.count >= signalPositions().count ||
        ![value[@"position"] isEqual:signalPositions()[_positionReadings.count]])
        return @{@"error":@"The input or measurement step changed. Check the current prompt."};
    _capturePosition = [value[@"position"] copy];
    _captureStartFrame = atomic_load(&_io->capturedFrames);
    _freshCapture = _quietReading = nil; _captureNote = nil;
    _captureStarted = NSProcessInfo.processInfo.systemUptime;
    if (_io->pilots) {
        _captureTag = (atomic_load(&_io->wantedTag) | 1u) + 1u;
        _captureAfter = 2; // Discard the first complete 250 ms after each output acknowledgement.
        atomic_store(&_io->wantedTag,_captureTag);
    } else { _captureTag = 0; _captureAfter = _lastOrdinal + 2; }
    return @{};
}
- (void)tick:(NSTimer *)timer {
    if (!_io) return;
    if (atomic_load(&_io->fault) || atomic_load(&_io->speakerFault)) {
        _detail = @"The audio queue stopped. Reconnect the adapter or restart the test.";
        if (_listeningProbe) [self recordRouteAttempt:@"Audio queue stopped"];
        if (_referenceMode) { [self saveReferenceReading]; _wanted = NO; }
        [self deactivate]; return;
    }
    if (_referenceMode) {
        BOOL withMic = [_referenceMode isEqual:ReferenceMic];
        BOOL playing = _wiredPlayer.isPlaying;
        BOOL ready = playing && (!withMic || atomic_load(&_io->capturedFrames) > 0);
        NSString *detail = !playing ? @"The reference player stopped." : !ready ? @"Waiting for wired microphone samples." :
            withMic ? @"Playing the reference tone and capturing the wired microphone." : @"Playing the reference tone with the microphone off.";
        if (ready != _ready || ![_detail isEqual:detail]) {
            _ready = ready; _detail = detail; [self batch:@[[self status]]];
        }
        return;
    }
    if (_measuring) { [self updateMeter]; return; }
    if (_io->meter) {
        PhoneSignalReading reading;
        while (phoneMeterRead(_io->meter,&reading)) _liveReading = signalReading(reading,_io->inputChannels);
        if (!_wiredPlayer.isPlaying) {
            NSString *waiting = @"Waiting for wired playback. Tap the contact test again if this persists.";
            if (_ready || ![_detail isEqual:waiting]) {
                _ready = NO; _detail = waiting; [self batch:@[[self status]]];
            }
            return;
        }
    }
    NSMutableArray *rows = [NSMutableArray array];
    unsigned epoch = phoneEpoch(_io->core);
    if (_epoch != epoch) {
        _epoch = epoch; [rows addObject:@{@"type":@"reset",@"epoch":@(_epoch)}]; [rows addObject:[self status]];
    }
    BOOL ready = phoneReady(_io->core);
    if (_ready != ready) {
        _ready = ready;
        if (!ready) _detail = @"Calibrating. Release both paddles.";
        else if (_systemProbe) _detail = @"Wired paddles ready. The system speaker test is set to 15 WPM.";
        else if (_contactsOnly) _detail = @"Reading wired paddle contacts.";
        else if (_io->speaker) _detail = [NSString stringWithFormat:@"Wired paddles ready. Sidetone output is %@.",[self listeningDestination]];
        else if (_listeningProbe && _strategy == StandardMultiroute && !_listedSpeaker)
            _detail = @"Wired audio is running. Check the paddle positions before trying the next route.";
        else _detail = [NSString stringWithFormat:@"Reading wired paddles. iOS did not offer a separate %@ output.",[self listeningDestination]];
        [rows addObject:[self status]];
    }
    if (_ready && !_contactsOnly) {
        _contactStates |= 1u << (phoneMask(_io->core) & 3u);
        [self attachListeningOutput];
    }
    ElementEvent e;
    PhoneMark mark;
    while (phoneEvent(_io->core,&e,&mark)) if (e.epoch == _epoch && _ready) {
        if (_systemProbe && mark != PhoneNoMark) {
            // Never play a backlog after a stalled UI thread. Scoring keeps its original timestamps.
            if (atomic_load(&_io->capturedFrames) <= e.frame + 2*_io->frames) [self playSystemCue:mark];
            else ++_missedMarks;
        }
        [rows addObject:@{@"type":@"element",@"session":@(_session),@"epoch":@(e.epoch),@"seq":@(++_sequence),
                          @"frame":@(e.frame),@"kind":@(e.kind),@"rate":@(e.rate)}];
    }
    [self batch:rows];
}
- (NSDictionary *)command:(NSString *)name value:(id)value {
    if ([name isEqual:@"input"]) {
        BOOL wanted = [value isEqual:@"paddle"];
        if (wanted != _wanted || _contactsOnly || _listeningProbe) {
            if (wanted && (_contactsOnly || _listeningProbe)) [self deactivate];
            _referenceMode = nil; _referenceReadings = nil;
            _contactsOnly = _measuring = _systemProbe = _listeningProbe = NO; _previousSpeakerAttempt = nil;
            _rememberedSpeaker = nil; _rememberedIn = nil; _lastRouteChange = nil;
            _strategy = StandardMultiroute; _routeAttempts = [NSMutableArray array];
            _bluetoothOutput = [NSUserDefaults.standardUserDefaults boolForKey:@"bluetooth-paddle-sidetone"];
            _wanted = wanted;
            if (wanted) [self start]; else { _detail = @"Audio converter off."; [self deactivate]; }
        }
    } else if ([name isEqual:@"probe"]) {
        if ([value isEqual:@"reference-stop"]) {
            if (_referenceMode && _wanted) {
                [self saveReferenceReading]; _wanted = NO; _detail = @"Reference tone stopped."; [self deactivate];
            }
            return @{};
        }
        BOOL referencePlayback = [value isEqual:ReferencePlayback], referenceMic = [value isEqual:ReferenceMic];
        if (referenceMic && ![_referenceMode isEqual:ReferencePlayback])
            return @{@"error":@"Start the playback-only comparison first."};
        if (referenceMic) [self saveReferenceReading];
        BOOL measuring = [value isEqual:@"signal"];
        BOOL systemProbe = [value isEqual:@"system-speaker"];
        BOOL contactsOnly = measuring || systemProbe || [value isEqual:@"contacts"] || referencePlayback || referenceMic;
        if (!contactsOnly && ![value isEqual:@"speaker"] && ![value isEqual:@"airpods"])
            return @{@"error":@"Unknown adapter test."};
        if (!contactsOnly || systemProbe) _previousSpeakerAttempt = nil;
        else if (_wanted && !_contactsOnly) _previousSpeakerAttempt = [self routeReport];
        [self deactivate];
        _systemProbe = systemProbe;
        _listeningProbe = !contactsOnly; _rememberedSpeaker = nil; _rememberedIn = nil; _lastRouteChange = nil;
        if (systemProbe) [_routeAttempts removeAllObjects];
        if (!contactsOnly) {
            _strategy = StandardMultiroute; _routeAttempts = [NSMutableArray array];
            _bluetoothOutput = [value isEqual:@"airpods"];
        }
        _referenceMode = referencePlayback ? ReferencePlayback : (referenceMic ? ReferenceMic : nil);
        if (referencePlayback) _referenceReadings = [NSMutableDictionary dictionary];
        if (!_referenceMode) _referenceReadings = nil;
        _measuring = measuring; _contactsOnly = contactsOnly; _wanted = YES; _mute = NO; _reverse = NO; _sound = nil;
        _detail = _referenceMode ? @"Opening the reference tone." : measuring ? @"Opening the wired audio meter." :
                  contactsOnly ? @"Opening wired contact test." : @"Checking the wired paddle and sidetone output.";
        [self start];
    } else if ([name isEqual:@"next-route"]) {
        if (!_listeningProbe || !_wanted || _strategy == PlayAndRecord || ![value isKindOfClass:NSDictionary.class] ||
            [value[@"session"] unsignedIntValue] != _session || ![value[@"strategy"] isEqual:strategyName(_strategy)])
            return @{@"error":@"The route has already changed."};
        NSString *reason = [value[@"baseline"] boolValue] ? @"Wired contact sequence completed" :
            [value[@"unheard"] boolValue] ? @"User reported no sidetone here" : @"User advanced";
        [self advanceStrategy:reason];
    } else if ([name isEqual:@"speaker-reference"]) {
        if (![value isKindOfClass:NSNumber.class] || [value unsignedIntValue] != _session || ![self playSystemCue:ReferenceCue])
            return @{@"error":@"The reference sound is unavailable. Release the paddles and try again."};
    } else if ([name isEqual:@"confirm-output"]) {
        if (!_listeningProbe || !_ready || !_io || !_io->speaker || !_wiredPlayer.isPlaying ||
            ![value isKindOfClass:NSDictionary.class] || [value[@"session"] unsignedIntValue] != _session ||
            [value[@"epoch"] unsignedIntValue] != _epoch || _contactStates != 15 ||
            atomic_load(&_io->capturedFrames) <= [_outputAttempt[@"inputFramesBefore"] unsignedLongLongValue] ||
            !atomic_load(&_io->returnedSidetoneFrames) || ![value[@"destination"] isEqual:(_bluetoothOutput ? @"airpods" : @"speaker")])
            return @{@"error":@"The sidetone route changed. Check the current output."};
        [NSUserDefaults.standardUserDefaults setBool:_bluetoothOutput forKey:@"bluetooth-paddle-sidetone"];
        if ([_outputAttempt[@"listedWhenAddressed"] boolValue])
            [NSUserDefaults.standardUserDefaults removeObjectForKey:@"verified-direct-paddle-uid"];
        else [NSUserDefaults.standardUserDefaults setObject:_speaker.UID forKey:@"verified-direct-paddle-uid"];
    } else if ([name isEqual:@"mark-signal"]) return [self markSignal:value];
    else if ([name isEqual:@"status"]) [self batch:@[[self status]]];
    else if ([name isEqual:@"reverse"]) { _reverse = [value boolValue]; [self applySound]; }
    else if ([name isEqual:@"mute"]) { _mute = [value boolValue]; if (_io) phoneMute(_io->core,_mute); }
    else if ([name isEqual:@"sound"]) { if ([value isKindOfClass:NSDictionary.class]) _sound = [value copy]; [self applySound]; }
    else if (![name isEqual:@"capture-position"] && ![name isEqual:@"disarm"] && ![name isEqual:@"vband-release"])
        return @{@"error":@"Unsupported iPhone input."};
    [self tick:nil];
    return @{@"sequence":@(_sequence)};
}
- (void)route:(NSNotification *)note {
    NSUInteger reason = [note.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue];
    AVAudioSessionRouteDescription *previous = note.userInfo[AVAudioSessionRouteChangePreviousRouteKey];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self->_configuredSession) return;
        AVAudioSessionRouteDescription *current = AVAudioSession.sharedInstance.currentRoute;
        self->_lastRouteChange = @{@"reason":@(reason), @"time":@(NSDate.date.timeIntervalSince1970),
            @"previousInputs":ports(previous.inputs), @"previousOutputs":ports(previous.outputs),
            @"inputs":ports(current.inputs), @"outputs":ports(current.outputs)};
        if (!self->_contactsOnly && !self->_listeningProbe && self->_strategy == PlayAndRecord && reason == AVAudioSessionRouteChangeReasonNewDeviceAvailable
            && NSProcessInfo.processInfo.systemUptime - self->_fallbackStarted > 1.) {
            [self deactivate]; self->_strategy = StandardMultiroute;
            [self->_routeAttempts removeAllObjects]; [self start]; return;
        }
        [self openRoute];
        if (!self->_io || !self->_io->speaker) [self scheduleNextStrategy];
    });
}
- (void)interrupt:(NSNotification *)note {
    BOOL began = [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan;
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_interrupted = began;
        if (began) {
            if (self->_listeningProbe && self->_io) [self recordRouteAttempt:@"Audio interrupted"];
            self->_detail = @"Audio interrupted."; [self deactivate];
        }
        else [self start];
    });
}
- (void)reset:(NSNotification *)note {
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_configuredSession = NO; self->_requestedInputUID = self->_channelRequestRoute = nil;
        self->_rememberedSpeaker = nil; self->_rememberedIn = nil;
        if (!self->_contactsOnly) self->_strategy = StandardMultiroute;
        self->_hadWiredInput = NO; [self clearIO]; [self start];
    });
}
- (void)suspend { _foreground = NO; _detail = @"Audio paused."; [self deactivate]; }
- (void)resume {
    _foreground = YES;
    if (!_configuredSession && _wanted && !_contactsOnly) {
        _strategy = StandardMultiroute; _rememberedSpeaker = nil; _rememberedIn = nil;
    }
    [self start];
}

// Browser lesson timelines are rendered on the explicitly assigned speaker while the
// adapter is active. This player never generates or grades paddle elements.
static NSData *wave(NSArray *tones, NSDictionary *settings) {
    const unsigned rate=16000;
    if (!tones.count || tones.count > 3000) return nil;
    double end=0;
    for (NSDictionary *tone in tones) {
        double start=[tone[@"start"] doubleValue], duration=[tone[@"duration"] doubleValue];
        if (!isfinite(start) || !isfinite(duration) || start < end-.000001 || duration <= 0 || start+duration > 1800) return nil;
        end=start+duration;
    }
    unsigned frames=(unsigned)ceil(end*rate)+1;
    NSMutableData *data=pcm16Wave(rate,1,frames);
    int16_t *samples=(int16_t *)((uint8_t *)data.mutableBytes+44);
    ToneSettings shape=defaultToneSettings;
    shape.riseMs=MAX(1,MIN(30,[settings[@"rise"] integerValue]));
    shape.fallMs=MAX(1,MIN(30,[settings[@"fall"] integerValue]));
    shape.curve=[settings[@"curve"] isEqual:@"linear"] ? LinearRamp :
                [settings[@"curve"] isEqual:@"exponential"] ? ExponentialRamp : RaisedCosine;
    double pitch=MAX(200,MIN(2000,[settings[@"tone"] doubleValue]));
    double level=32767*.23*MAX(0,MIN(100,[settings[@"volume"] doubleValue]))/100.;
    for (NSDictionary *tone in tones) {
        unsigned start=(unsigned)lround([tone[@"start"] doubleValue]*rate);
        unsigned n=MIN(frames-start,(unsigned)lround([tone[@"duration"] doubleValue]*rate));
        if (!n) continue;
        ToneRamps envelope=fitToneRamps(shape,rate,n);
        for (unsigned i=0;i<n;++i) samples[start+i]=(int16_t)lround(level*toneEnvelopeGain(&envelope,i)*sin(2*M_PI*pitch*i/rate));
    }
    return data;
}
- (void)play:(NSDictionary *)plan reply:(PhoneReply)reply {
    [self stopPrompt:nil];
    NSString *identifier=plan[@"id"];
    if (!_io || !_speaker || ![identifier isKindOfClass:NSString.class]) {
        reply(@{@"error":@"The sidetone output is unavailable."}); return;
    }
    _promptID=[identifier copy]; _promptReply=[reply copy];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
        NSData *data=wave(plan[@"tones"], plan[@"settings"]);
        dispatch_async(dispatch_get_main_queue(), ^{
            if (![self->_promptID isEqual:identifier]) return;
            NSError *error=nil;
            self->_prompt=data ? [[AVAudioPlayer alloc] initWithData:data error:&error] : nil;
            self->_prompt.delegate=self;
            AVAudioSessionChannelDescription *channel=self->_speaker.channels.firstObject;
            if (channel) self->_prompt.channelAssignments=@[channel];
            if (!channel || ![self->_prompt play]) {
                PhoneReply pending=self->_promptReply; self->_promptReply=nil; [self stopPrompt:nil];
                pending(@{@"error":error.localizedDescription ?: @"Could not play the lesson on the selected output."}); return;
            }
            [self batch:@[@{@"type":@"prompt-start",@"id":identifier,@"elapsed":@(self->_prompt.currentTime)}]];
        });
    });
}
- (void)stopPrompt:(NSString *)identifier {
    if (identifier && ![_promptID isEqual:identifier]) return;
    [_prompt stop]; _prompt=nil; _promptID=nil;
    PhoneReply reply=_promptReply; _promptReply=nil;
    if (reply) reply(@{@"completed":@NO});
}
- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)flag {
    if (player!=_prompt) return;
    PhoneReply reply=_promptReply; _promptReply=nil; _prompt=nil; _promptID=nil;
    if (reply) reply(@{@"completed":@(flag)});
}
- (void)audioPlayerDecodeErrorDidOccur:(AVAudioPlayer *)player error:(NSError *)error {
    if (player==_prompt) [self stopPrompt:nil];
}
@end
