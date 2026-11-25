#import "PaddleAudio.h"
#import "Core.h"
#import "Sidetone.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#include <math.h>

typedef struct {
    PhoneCore *core;
    AudioQueueRef pilots, input, speaker;
    unsigned frames;
    atomic_bool live;
    atomic_int fault;
    _Atomic(uint64_t) capturedFrames;
} PhoneIO;

static void queued(PhoneIO *io, AudioQueueRef queue, AudioQueueBufferRef b) {
    OSStatus result = AudioQueueEnqueueBuffer(queue, b, 0, NULL);
    if (result) atomic_store(&io->fault, result);
}
static void output(void *context, AudioQueueRef queue, AudioQueueBufferRef b) {
    PhoneIO *io = context;
    if (!atomic_load(&io->live)) return;
    if (queue == io->pilots) phonePilots(io->core, b->mAudioData, io->frames);
    else phoneSpeaker(io->core, b->mAudioData, io->frames);
    b->mAudioDataByteSize = io->frames * sizeof(float) * (queue == io->pilots ? 2 : 1);
    queued(io, queue, b);
}
static void input(void *context, AudioQueueRef q, AudioQueueBufferRef b, const AudioTimeStamp *stamp,
                  UInt32 packets, const AudioStreamPacketDescription *descriptions) {
    PhoneIO *io = context;
    if (!atomic_load(&io->live)) return;
    unsigned frames = b->mAudioDataByteSize / sizeof(float);
    phoneInput(io->core, b->mAudioData, frames);
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
    phoneDestroy(io->core);
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
    for (unsigned i=0; i<3 && !code; ++i) {
        AudioQueueBufferRef b = NULL;
        code = AudioQueueAllocateBuffer(*target, io->frames * f.mBytesPerFrame, &b);
        if (code) break;
        if (recording) queued(io,*target,b); else output(io,*target,b);
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
    BOOL _contactsOnly, _hadWiredInput;
    unsigned _session, _epoch, _sequence;
    NSString *_detail, *_routes, *_promptID;
    NSString *_requestedInputUID, *_inputRequest;
    NSDictionary *_previousSpeakerAttempt;
    NSTimeInterval _nextRouteCheck;
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
    return @{@"status":[self status],@"testMode":_contactsOnly?@"contacts":@"speaker",
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
    if (_configuredSession && !_io && NSProcessInfo.processInfo.systemUptime >= _nextRouteCheck) [self openRoute];
    NSMutableDictionary *report = [[self routeReport] mutableCopy];
    report[@"build"] = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @"";
    report[@"canTestContacts"] = @(_wanted && _granted && _foreground && !_interrupted && !_io && !_contactsOnly);
    if (_previousSpeakerAttempt) report[@"previousSpeakerAttempt"] = _previousSpeakerAttempt;
    return report;
}
- (void)clearIO {
    [self stopPrompt:nil];
    [_timer invalidate]; _timer = nil;
    dispose(_io); _io = NULL; _speaker = nil; _ready = NO;
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
    AVAudioSessionRouteDescription *route = s.currentRoute;
    double rate = s.sampleRate;
    NSString *key = routeKey(route,rate);
    if ([_routes isEqual:key]) return;
    [self clearIO]; _routes = key;
    AVAudioSessionPortDescription *mic = singlePort(route.inputs,inputTypes,1);
    AVAudioSessionPortDescription *wire = singlePort(route.outputs,@[AVAudioSessionPortHeadphones,AVAudioSessionPortUSBAudio],2);
    _speaker = _contactsOnly ? nil : singlePort(route.outputs,@[AVAudioSessionPortBuiltInSpeaker],1);
    NSString *waiting = nil;
    if (!mic) waiting = @"Waiting for iOS to activate the wired microphone.";
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
    atomic_init(&io->live, true);
    atomic_init(&io->fault, 0);
    atomic_init(&io->capturedFrames, 0);
    AudioQueueRef *targets[] = {&io->input,&io->pilots,&io->speaker};
    AVAudioSessionPortDescription *devices[] = {mic,wire,_speaker};
    NSArray *names = @[@"wired microphone",@"wired sensing tones",@"iPhone speaker"];
    unsigned count = _contactsOnly ? 2 : 3;
    OSStatus code = noErr;
    NSString *operation = nil;
    for (unsigned i=0; i<count && !code; ++i) {
        code = prepare(io,_contactsOnly ? nil : devices[i],i == 1 ? 2 : 1,rate,targets[i],i == 0);
        if (code) operation = [@"prepare " stringByAppendingString:names[i]];
    }
    for (unsigned i=count; i>0 && !code; --i) {
        code = AudioQueueStart(*targets[i-1],NULL);
        if (code) operation = [@"start " stringByAppendingString:names[i-1]];
    }
    if (code) {
        [self clearIO]; _routes = key;
        _detail = [NSString stringWithFormat:@"Could not %@ (OSStatus %d).",operation,(int)code];
        [self batch:@[[self status]]]; return;
    }
    _detail = @"Calibrating. Release both paddles.";
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
- (void)tick:(NSTimer *)timer {
    if (!_io) return;
    if (atomic_load(&_io->fault)) {
        _detail = @"The audio queue stopped. Reconnect the adapter or restart the test.";
        [self deactivate]; return;
    }
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
            _contactsOnly = NO; _previousSpeakerAttempt = nil;
            _wanted = wanted;
            if (wanted) [self start]; else { _detail = @"Audio converter off."; [self deactivate]; }
        }
    } else if ([name isEqual:@"probe"]) {
        BOOL contactsOnly = [value isEqual:@"contacts"];
        if (!contactsOnly) _previousSpeakerAttempt = nil;
        else if (_wanted && !_contactsOnly) _previousSpeakerAttempt = [self routeReport];
        [self deactivate];
        _contactsOnly = contactsOnly; _wanted = YES; _mute = NO; _reverse = NO; _sound = nil;
        _detail = contactsOnly ? @"Opening wired contact test." : @"Opening paddle and iPhone speaker test.";
        [self start];
    } else if ([name isEqual:@"status"]) [self batch:@[[self status]]];
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
    dispatch_async(dispatch_get_main_queue(), ^{ self->_configuredSession = NO; [self clearIO]; [self start]; });
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
