#import "PaddleAudio.h"
#import "Core.h"
#import "Sidetone.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#include <math.h>

typedef struct { unsigned tag; float peak[2]; } PilotBuffer;
enum { BufferCount = 3 };
typedef struct {
    PhoneCore *core;
    PhoneSignalMeter *meter;
    AudioQueueRef pilots, input, speaker;
    unsigned frames, inputChannels;
    atomic_bool live;
    atomic_int fault;
    atomic_uint wantedTag, returnedTag;
    _Atomic(uint64_t) capturedFrames, toneFrames, silentFrames;
    PilotBuffer pilotBuffers[BufferCount];
    _Atomic(float) returnedTonePeak[2];
} PhoneIO;

static void queued(PhoneIO *io, AudioQueueRef queue, AudioQueueBufferRef b) {
    OSStatus result = AudioQueueEnqueueBuffer(queue, b, 0, NULL);
    if (result) atomic_store(&io->fault, result);
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
    else phoneSpeaker(io->core, b->mAudioData, io->frames);
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
    }
    fillOutput(io,queue,b);
}
static void input(void *context, AudioQueueRef q, AudioQueueBufferRef b, const AudioTimeStamp *stamp,
                  UInt32 packets, const AudioStreamPacketDescription *descriptions) {
    PhoneIO *io = context;
    if (!atomic_load(&io->live)) return;
    unsigned frames = b->mAudioDataByteSize / (sizeof(float)*io->inputChannels);
    if (io->meter) phoneMeterInput(io->meter,b->mAudioData,frames,atomic_load(&io->returnedTag));
    else phoneInput(io->core,b->mAudioData,frames);
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
                        double rate, AudioQueueRef *target, BOOL recording) {
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
    }
    for (unsigned i=0; i<BufferCount && !code; ++i) {
        AudioQueueBufferRef b = NULL;
        code = AudioQueueAllocateBuffer(*target, io->frames * f.mBytesPerFrame, &b);
        if (code) break;
        if (*target == io->pilots) b->mUserData = &io->pilotBuffers[i];
        if (recording) queued(io,*target,b); else fillOutput(io,*target,b);
        code = atomic_load(&io->fault);
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
static NSString *routeKey(AVAudioSessionRouteDescription *route, double rate) {
    NSMutableArray *parts = [NSMutableArray arrayWithObject:@(rate)];
    for (NSArray *side in @[route.inputs,route.outputs]) {
        [parts addObject:@"|"];
        for (AVAudioSessionPortDescription *p in side) [parts addObject:@[p.UID,p.portType,@(p.channels.count)]];
    }
    return parts.description;
}

@interface PaddleAudio () <AVAudioPlayerDelegate>
@end
@implementation PaddleAudio {
    PhoneIO *_io;
    BOOL _wanted, _foreground, _granted, _requesting, _interrupted, _configuredSession, _ready, _reverse, _mute;
    BOOL _contactsOnly, _hadWiredInput, _measuring;
    unsigned _session, _epoch, _sequence;
    NSString *_detail, *_routes, *_promptID;
    NSString *_requestedInputUID, *_inputRequest;
    NSDictionary *_previousSpeakerAttempt;
    NSTimeInterval _nextRouteCheck;
    NSString *_channelRequestRoute, *_channelRequest, *_capturePosition, *_captureNote;
    NSString *_inputFallback, *_outputIssue;
    NSDictionary *_liveReading, *_quietReading, *_freshCapture;
    NSMutableArray *_positionReadings;
    unsigned _captureTag, _captureAfter, _lastOrdinal;
    uint64_t _captureStartFrame;
    NSTimeInterval _captureStarted;
    NSDictionary *_sound;
    AVAudioSessionPortDescription *_speaker;
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
- (NSDictionary *)status {
    BOOL speakerActive = _io && _io->speaker;
    return @{@"type":@"status",@"source":_wanted?@"paddle":@"off",
        @"phase":_ready?@"ready":_io?@"calibrating":@"waiting",@"outputReady":@(speakerActive),
        @"output":speakerActive?@"iPhone speaker":@"System output",@"sharedSound":@(!_contactsOnly),@"typing":@NO,
        @"hasReverse":@NO,@"reverse":@(_reverse),@"session":@(_session),@"epoch":@(_epoch),@"detail":_detail ?: @""};
}
- (NSDictionary *)routeReport {
    AVAudioSession *s = AVAudioSession.sharedInstance;
    AVAudioSessionRouteDescription *route = s.currentRoute;
    AVAudioSessionPortDescription *preferred = s.preferredInput;
    return @{@"status":[self status],@"testMode":_measuring?@"signal":_contactsOnly?@"contacts":@"speaker",
        @"category":s.category,@"mode":s.mode,@"availableInputs":ports(s.availableInputs),
        @"preferredInput":preferred ? portInfo(preferred) : (id)NSNull.null,
        @"inputRequest":_inputRequest ?: @"No input request made.",
        @"inputs":ports(route.inputs),@"outputs":ports(route.outputs),
        @"rate":@(s.sampleRate),@"mask":@(_io ? phoneMask(_io->core) : 0),
        @"speakerActive":@(_io && _io->speaker),@"capturedFrames":@(_io ? atomic_load(&_io->capturedFrames) : 0),
        @"audibleFrames":@(_io ? phoneAudibleFrames(_io->core) : 0),@"active":@(_io != NULL)};
}
- (NSDictionary *)snapshot {
    // An available mic can appear before iOS changes the active route.
    if (_configuredSession && (!_io || _measuring) && NSProcessInfo.processInfo.systemUptime >= _nextRouteCheck) [self openRoute];
    NSMutableDictionary *report = [[self routeReport] mutableCopy];
    report[@"build"] = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @"";
    report[@"canTestContacts"] = @(_wanted && _granted && _foreground && !_interrupted && !_io && !_contactsOnly);
    if (_previousSpeakerAttempt) report[@"previousSpeakerAttempt"] = _previousSpeakerAttempt;
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
- (void)clearIO {
    [self stopPrompt:nil];
    [_timer invalidate]; _timer = nil;
    dispose(_io); _io = NULL; _speaker = nil; _ready = NO;
    _liveReading = _quietReading = _freshCapture = nil; _positionReadings = nil; _capturePosition = _captureNote = nil;
    _inputFallback = _outputIssue = nil; _lastOrdinal = 0;
    _routes = nil; _epoch = 0; ++_session;
    [self batch:@[@{@"type":@"reset"}]];
}
- (void)deactivate {
    [self clearIO];
    if (_configuredSession) {
        _configuredSession = NO;
        AVAudioSession *s = AVAudioSession.sharedInstance;
        if (_requestedInputUID && [s.preferredInput.UID isEqual:_requestedInputUID]) [s setPreferredInput:nil error:nil];
        [s setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    }
    _requestedInputUID = nil; _inputRequest = nil; _hadWiredInput = NO;
    _channelRequestRoute = _channelRequest = nil;
    [self batch:@[[self status]]];
}
- (void)applySound {
    if (!_io) return;
    if (_sound) phoneSound(_io->core, [_sound[@"wpm"] unsignedIntValue], [_sound[@"farnsworth"] unsignedIntValue],
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
    if (_io) [self clearIO];
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
        code = prepare(io,nil,io->inputChannels,rate,&io->input,YES);
        if (!code || io->inputChannels == 1) break;
        _inputFallback = [NSString stringWithFormat:@"iOS rejected stereo capture (%d). Reading mono.",(int)code];
        if (io->input) { AudioQueueDispose(io->input,true); io->input = NULL; }
        atomic_store(&io->fault,0);
        phoneMeterDestroy(io->meter); io->meter = NULL; io->inputChannels = 1;
    }
    if (code) return code;
    if (drive) {
        code = prepare(io,nil,2,rate,&io->pilots,NO);
        if (!code) code = AudioQueueStart(io->pilots,NULL);
        if (code) {
            _outputIssue = [NSString stringWithFormat:@"Could not start wired stereo output (%d).",(int)code];
            if (io->pilots) { AudioQueueDispose(io->pilots,true); io->pilots = NULL; }
            atomic_store(&io->fault,0);
        }
    } else _outputIssue = @"The current route has no isolated stereo wired output.";
    return AudioQueueStart(io->input,NULL);
}
- (void)openRoute {
    if (!_foreground || _interrupted || !_wanted || !_granted) return;
    _nextRouteCheck = NSProcessInfo.processInfo.systemUptime + 1.;
    AVAudioSession *s = AVAudioSession.sharedInstance;
    NSError *error = nil;
    if (!_configuredSession) {
        AVAudioSessionCategory category = _contactsOnly ? AVAudioSessionCategoryPlayAndRecord : AVAudioSessionCategoryMultiRoute;
        AVAudioSessionMode mode = _contactsOnly ? AVAudioSessionModeDefault : AVAudioSessionModeDualRoute;
        AVAudioSessionCategoryOptions options = _contactsOnly ? 0 : AVAudioSessionCategoryOptionAllowBluetoothHFP;
        if (![s setCategory:category mode:mode options:options error:&error] || ![s setActive:YES error:&error]) {
            _detail = error.localizedDescription ?: @"iOS could not activate the audio session.";
            [self batch:@[[self status]]]; return;
        }
        _configuredSession = YES;
    }
    NSArray *inputTypes = @[AVAudioSessionPortHeadsetMic,AVAudioSessionPortUSBAudio];
    [self requestWiredInput:s types:inputTypes];
    if (_measuring) [self requestProbeChannels:s types:inputTypes];
    AVAudioSessionRouteDescription *route = s.currentRoute;
    double rate = s.sampleRate;
    NSString *key = routeKey(route,rate);
    if (_measuring) key = [key stringByAppendingFormat:@"|%ld|%ld",(long)s.inputNumberOfChannels,(long)s.outputNumberOfChannels];
    if ([_routes isEqual:key]) return;
    [self clearIO]; _routes = key;
    AVAudioSessionPortDescription *mic = singlePort(route.inputs,inputTypes,1);
    AVAudioSessionPortDescription *wire = singlePort(route.outputs,@[AVAudioSessionPortHeadphones,AVAudioSessionPortUSBAudio],2);
    _speaker = _contactsOnly ? nil : singlePort(route.outputs,@[AVAudioSessionPortBuiltInSpeaker],1);
    NSString *waiting = nil;
    if (!mic) waiting = @"Waiting for iOS to activate the wired microphone.";
    else if (_measuring) {
        if (route.inputs.count != 1 || s.inputNumberOfChannels < 1) waiting = @"Waiting for the wired input channel.";
    }
    else if (!wire) waiting = @"Waiting for two wired output channels for the paddle sensing tones.";
    else if (!_contactsOnly && !_speaker) waiting = @"The wired ports are active. Waiting for the iPhone speaker.";
    else if (_contactsOnly && (route.inputs.count != 1 || route.outputs.count != 1))
        waiting = @"The contacts test needs one wired input and one wired output.";
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
    io->frames = MAX(64u, (unsigned)lround(rate * .003));
    io->inputChannels = _measuring ? (unsigned)MIN((NSInteger)MIN((NSUInteger)2,mic.channels.count),s.inputNumberOfChannels) : 1;
    atomic_init(&io->live, true);
    atomic_init(&io->fault, 0);
    atomic_init(&io->capturedFrames, 0);
    atomic_init(&io->wantedTag,1); atomic_init(&io->returnedTag,0);
    atomic_init(&io->toneFrames,0); atomic_init(&io->silentFrames,0);
    for (unsigned ch=0; ch<2; ++ch) atomic_init(&io->returnedTonePeak[ch],0);
    OSStatus code = noErr;
    NSString *operation = nil;
    if (_measuring) {
        operation = @"open the wired input meter";
        _positionReadings = [NSMutableArray array];
        code = [self startMeterQueues:io rate:rate drive:(wire && route.outputs.count == 1 && s.outputNumberOfChannels >= 2)];
    } else {
        AudioQueueRef *targets[] = {&io->input,&io->pilots,&io->speaker};
        AVAudioSessionPortDescription *devices[] = {mic,wire,_speaker};
        NSArray *names = @[@"wired microphone",@"wired sensing tones",@"iPhone speaker"];
        unsigned count = _contactsOnly ? 2 : 3;
        for (unsigned i=0; i<count && !code; ++i) {
            code = prepare(io,_contactsOnly ? nil : devices[i],i == 1 ? 2 : 1,rate,targets[i],i == 0);
            if (code) operation = [@"prepare " stringByAppendingString:names[i]];
        }
        for (unsigned i=count; i>0 && !code; --i) {
            code = AudioQueueStart(*targets[i-1],NULL);
            if (code) operation = [@"start " stringByAppendingString:names[i-1]];
        }
    }
    if (code) {
        [self clearIO]; _routes = key;
        _detail = [NSString stringWithFormat:@"Could not %@ (OSStatus %d).",operation,(int)code];
        [self batch:@[[self status]]]; return;
    }
    _detail = _measuring ? @"Waiting for input samples." : @"Calibrating. Release both paddles.";
    [self batch:@[[self status]]];
    _timer = [NSTimer timerWithTimeInterval:.025 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
    [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
}
- (void)start {
    if (!_wanted || !_foreground || _interrupted) return;
    if (_granted) { [self openRoute]; return; }
    if (_requesting) return;
    _requesting = YES;
    [AVAudioApplication requestRecordPermissionWithCompletionHandler:^(BOOL allowed) {
        dispatch_async(dispatch_get_main_queue(), ^{
            self->_requesting = NO; self->_granted = allowed;
            if (allowed) [self openRoute];
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
    if (atomic_load(&_io->fault)) {
        _detail = @"The audio queue stopped. Reconnect the adapter or restart the test.";
        [self deactivate]; return;
    }
    if (_measuring) { [self updateMeter]; return; }
    NSMutableArray *rows = [NSMutableArray array];
    unsigned epoch = phoneEpoch(_io->core);
    if (_epoch != epoch) {
        _epoch = epoch; [rows addObject:@{@"type":@"reset",@"epoch":@(_epoch)}]; [rows addObject:[self status]];
    }
    BOOL ready = phoneReady(_io->core);
    if (_ready != ready) {
        _ready = ready;
        _detail = ready ? (_contactsOnly ? @"Reading wired paddle contacts." : @"Wired paddles and iPhone speaker ready.")
                        : @"Calibrating. Release both paddles.";
        [rows addObject:[self status]];
    }
    ElementEvent e;
    while (phoneEvent(_io->core,&e)) if (e.epoch == _epoch && _ready)
        [rows addObject:@{@"type":@"element",@"session":@(_session),@"epoch":@(e.epoch),@"seq":@(++_sequence),
                          @"frame":@(e.frame),@"kind":@(e.kind),@"rate":@(e.rate)}];
    [self batch:rows];
}
- (NSDictionary *)command:(NSString *)name value:(id)value {
    if ([name isEqual:@"input"]) {
        BOOL wanted = [value isEqual:@"paddle"];
        if (wanted != _wanted || _contactsOnly) {
            if (wanted && _contactsOnly) [self deactivate];
            _contactsOnly = _measuring = NO; _previousSpeakerAttempt = nil;
            _wanted = wanted;
            if (wanted) [self start]; else { _detail = @"Audio converter off."; [self deactivate]; }
        }
    } else if ([name isEqual:@"probe"]) {
        BOOL measuring = [value isEqual:@"signal"];
        BOOL contactsOnly = measuring || [value isEqual:@"contacts"];
        if (!contactsOnly) _previousSpeakerAttempt = nil;
        else if (_wanted && !_contactsOnly) _previousSpeakerAttempt = [self routeReport];
        [self deactivate];
        _measuring = measuring; _contactsOnly = contactsOnly; _wanted = YES; _mute = NO; _reverse = NO; _sound = nil;
        _detail = measuring ? @"Opening the wired audio meter." :
                  contactsOnly ? @"Opening wired contact test." : @"Opening paddle and iPhone speaker test.";
        [self start];
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
    dispatch_async(dispatch_get_main_queue(), ^{ if (self->_configuredSession) [self openRoute]; });
}
- (void)interrupt:(NSNotification *)note {
    BOOL began = [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan;
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_interrupted = began;
        if (began) { self->_detail = @"Audio interrupted."; [self deactivate]; }
        else [self start];
    });
}
- (void)reset:(NSNotification *)note {
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_configuredSession = NO; self->_requestedInputUID = self->_channelRequestRoute = nil;
        self->_hadWiredInput = NO; [self clearIO]; [self start];
    });
}
- (void)suspend { _foreground = NO; _detail = @"Audio paused."; [self deactivate]; }
- (void)resume { _foreground = YES; [self start]; }

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
    unsigned frames=(unsigned)ceil(end*rate)+1, bytes=2*frames;
    NSMutableData *data=[NSMutableData dataWithLength:44+bytes];
    unsigned char *header=data.mutableBytes;
    memcpy(header,"RIFF",4); memcpy(header+8,"WAVEfmt ",8); memcpy(header+36,"data",4);
    uint32_t size=bytes+36, fmt=16, byteRate=rate*2;
    uint16_t pcm=1, mono=1, align=2, bits=16;
    memcpy(header+4,&size,4); memcpy(header+16,&fmt,4); memcpy(header+20,&pcm,2);
    memcpy(header+22,&mono,2); memcpy(header+24,&rate,4); memcpy(header+28,&byteRate,4);
    memcpy(header+32,&align,2); memcpy(header+34,&bits,2); memcpy(header+40,&bytes,4);
    int16_t *samples=(int16_t *)(header+44);
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
        reply(@{@"error":@"The speaker route is unavailable."}); return;
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
                pending(@{@"error":error.localizedDescription ?: @"Could not play the lesson on the iPhone speaker."}); return;
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
