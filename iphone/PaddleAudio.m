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
    phoneInput(io->core, b->mAudioData, b->mAudioDataByteSize / sizeof(float));
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
    // Queue channel assignments are bound to a port UID and a 1-based port-local channel.
    AudioQueueChannelAssignment map[2] = {0};
    for (unsigned i=0; i<channels; ++i) {
        map[i].mDeviceUID = (__bridge CFStringRef)port.UID;
        map[i].mChannelNumber = i + 1;
    }
    code = AudioQueueSetProperty(*target,kAudioQueueProperty_ChannelAssignments,map,channels*sizeof(map[0]));
    for (unsigned i=0; i<3 && !code; ++i) {
        AudioQueueBufferRef b = NULL;
        code = AudioQueueAllocateBuffer(*target, io->frames * f.mBytesPerFrame, &b);
        if (code) break;
        if (recording) queued(io,*target,b); else output(io,*target,b);
        code = atomic_load(&io->fault);
    }
    return code;
}

static NSArray *ports(NSArray<AVAudioSessionPortDescription *> *items) {
    NSMutableArray *result = [NSMutableArray array];
    for (AVAudioSessionPortDescription *p in items)
        [result addObject:@{@"type":p.portType,@"name":p.portName,@"channels":@(p.channels.count)}];
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
static NSString *routeKey(AVAudioSession *s) {
    NSMutableArray *parts = [NSMutableArray arrayWithObject:@(s.sampleRate)];
    for (NSArray *side in @[s.currentRoute.inputs,s.currentRoute.outputs]) {
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
    unsigned _session, _epoch, _sequence;
    NSString *_detail, *_routes, *_promptID;
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
    return @{@"type":@"status",@"source":_wanted?@"paddle":@"off",
        @"phase":_ready?@"ready":_io?@"calibrating":@"waiting",@"outputReady":@(_io!=NULL),
        @"output":_io?@"iPhone speaker":@"System output",@"sharedSound":@YES,@"typing":@NO,
        @"hasReverse":@NO,@"reverse":@(_reverse),@"session":@(_session),@"epoch":@(_epoch),@"detail":_detail ?: @""};
}
- (NSDictionary *)snapshot {
    AVAudioSession *s = AVAudioSession.sharedInstance;
    return @{@"status":[self status],@"inputs":ports(s.currentRoute.inputs),@"outputs":ports(s.currentRoute.outputs),
        @"rate":@(s.sampleRate),@"mask":@(_io ? phoneMask(_io->core) : 0),
        @"audibleFrames":@(_io ? phoneAudibleFrames(_io->core) : 0),@"active":@(_io != NULL)};
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
        [AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    }
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
- (void)openRoute {
    if (!_foreground || _interrupted || !_wanted || !_granted) return;
    AVAudioSession *s = AVAudioSession.sharedInstance;
    NSError *error = nil;
    if (!_configuredSession) {
        if (![s setCategory:AVAudioSessionCategoryMultiRoute mode:AVAudioSessionModeDualRoute
                     options:AVAudioSessionCategoryOptionAllowBluetoothHFP error:&error] || ![s setActive:YES error:&error]) {
            _detail = error.localizedDescription ?: @"iOS could not activate dual-route audio.";
            [self batch:@[[self status]]]; return;
        }
        _configuredSession = YES;
    }
    NSString *key = routeKey(s);
    if ([_routes isEqual:key]) return;
    [self clearIO]; _routes = key;
    AVAudioSessionPortDescription *mic = singlePort(s.currentRoute.inputs,@[AVAudioSessionPortHeadsetMic,AVAudioSessionPortUSBAudio],1);
    AVAudioSessionPortDescription *wire = singlePort(s.currentRoute.outputs,@[AVAudioSessionPortHeadphones,AVAudioSessionPortUSBAudio],2);
    _speaker = singlePort(s.currentRoute.outputs,@[AVAudioSessionPortBuiltInSpeaker],1);
    if (!mic || !wire || !_speaker) {
        _detail = @"Waiting for a wired mic, stereo wired output and iPhone speaker on the same route.";
        [self batch:@[[self status]]]; return;
    }
    PhoneIO *io = calloc(1,sizeof(*io));
    if (!io || !(io->core = phoneCreate(s.sampleRate))) {
        free(io); _detail = @"The reported audio sample rate or buffer allocation is unavailable.";
        [self batch:@[[self status]]]; return;
    }
    _io = io; [self applySound];
    io->frames = MAX(64u, (unsigned)lround(s.sampleRate * .003));
    atomic_init(&io->live, true);
    OSStatus code = prepare(io,mic,1,s.sampleRate,&io->input,YES);
    if (!code) code = prepare(io,wire,2,s.sampleRate,&io->pilots,NO);
    if (!code) code = prepare(io,_speaker,1,s.sampleRate,&io->speaker,NO);
    if (!code) code = AudioQueueStart(io->speaker,NULL);
    if (!code) code = AudioQueueStart(io->pilots,NULL);
    if (!code) code = AudioQueueStart(io->input,NULL);
    if (code) {
        [self clearIO]; _routes = key;
        _detail = [NSString stringWithFormat:@"iOS rejected the audio channel assignment or queue (%d).",(int)code];
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
        _ready = ready; _detail = ready ? @"Wired paddles and iPhone speaker ready." : @"Calibrating. Release both paddles.";
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
        if (wanted != _wanted) {
            _wanted = wanted;
            if (wanted) [self start]; else { _detail = @"Audio converter off."; [self deactivate]; }
        }
    } else if ([name isEqual:@"probe"]) {
        _wanted = YES; _mute = NO; _reverse = NO; _sound = nil;
        [self deactivate]; [self start];
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
