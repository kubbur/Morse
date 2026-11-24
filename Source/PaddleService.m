#import <AppKit/AppKit.h>
#import "DevicePreferences.h"
#import "MorseEngine.h"
#import "TypingKeys.h"
#import "VBandTarget.h"
#include <signal.h>
#include <unistd.h>

static void emit(NSDictionary *message) {
    NSData *line=[NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
    if (!line || fwrite(line.bytes,1,line.length,stdout)!=line.length || fputc('\n',stdout)==EOF || fflush(stdout)) _exit(0);
}
@interface PaddleService : NSObject
@property MorseEngine *engine;
@property DevicePreferences *prefs;
@property NSString *phase, *detail, *outputLabel;
@property NSArray *outputs;
@property unsigned epoch, sequence, calibration;
@property BOOL sampling, active, isolated, typingEnabled, awaitRelease;
@property NSUInteger focusGeneration;
@property (copy) NSString *typingIssue;
@property (copy) NSString *source;
@property (strong) VBandTarget *vbandTarget;
@property NSTimeInterval controlSince;
@property (strong) NSTimer *eventTimer;
@property pid_t target;
- (void)tick;
- (NSDictionary *)command:(NSDictionary *)m;
@end
@implementation PaddleService
- (void)usbContacts:(unsigned)mask {
    if (mask && !_controlSince) _controlSince=NSProcessInfo.processInfo.systemUptime;
    if (!mask) _controlSince=0;
    [_engine setVBandContacts:mask];
}
- (void)clearTypingTarget {
    ++_focusGeneration;
    _target=0;
    [_engine setTypingDestination:0];
    _vbandTarget=nil;
    _awaitRelease=YES;
    [self usbContacts:0];
}
- (void)disarm {
    if (_typingEnabled) {
        _typingEnabled=NO;
        [self clearTypingTarget];
        [_engine interruptInput];
    }
}
- (BOOL)canArm {
    return !_isolated && [_phase isEqual:@"ready"] && [_outputLabel hasPrefix:@"Output"] && !_sampling &&
        ([_source isEqual:@"vband"] || ([_source isEqual:@"paddle"] && (_calibration==InputInactive || _calibration==InputCalibrated)));
}
- (pid_t)focusedTypingPID {
    NSRunningApplication *app=NSWorkspace.sharedWorkspace.frontmostApplication;
    if (app.activationPolicy!=NSApplicationActivationPolicyRegular || app.isTerminated ||
        app.processIdentifier==getppid() || [app.bundleIdentifier isEqual:@"digital.kubbur.morse"]) return 0;
    return MAX(0,app.processIdentifier);
}
- (BOOL)hasTypingAccess { return CGPreflightPostEventAccess(); }
- (unsigned)heldVBandControls { return vbandHeldControls(); }
- (VBandTarget *)watchPID:(pid_t)pid contacts:(void (^)(unsigned))contacts stopped:(void (^)(void))stopped {
    return [[VBandTarget alloc] initWithPID:pid contacts:contacts stopped:stopped];
}
- (void)postKey:(char)character toPID:(pid_t)pid { postTypingKey(pid,character); }
- (BOOL)stillTypingTo:(pid_t)pid {
    return pid>0 && _typingEnabled && _target==pid && _epoch==_engine.elementEpoch &&
        [self focusedTypingPID]==pid && [self hasTypingAccess];
}
- (void)followPID:(pid_t)pid {
    // Invalidate partial and queued characters, even on a quick return to a previous PID.
    [self clearTypingTarget];
    if (!pid) return;
    if ([_source isEqual:@"vband"]) {
        NSUInteger generation=_focusGeneration;
        __weak PaddleService *weak=self;
        _vbandTarget=[self watchPID:pid contacts:^(unsigned mask) {
            PaddleService *host=weak;
            if (host.focusGeneration!=generation || ![host stillTypingTo:pid]) return;
            if (host.awaitRelease) { if (!mask) host.awaitRelease=NO; return; }
            [host usbContacts:mask];
        } stopped:^{
            PaddleService *host=weak;
            if (host.focusGeneration==generation) { [host disarm]; [host status]; }
        }];
        if (!_vbandTarget) {
            [self disarm];
            _typingIssue=@"VBand could not read the controls in this app. Check Accessibility, then enable typing again.";
            [self status];
            return;
        }
        _awaitRelease=[self heldVBandControls]!=0;
    }
    _target=pid;
    [_engine setTypingDestination:pid];
}
- (void)reconcileInput {
    BOOL audio=[_source isEqual:@"paddle"];
    BOOL occupied=audio && !_isolated && [NSRunningApplication runningApplicationsWithBundleIdentifier:@"is.kubbur.morsepaddle"].count>0;
    PaddleInputMode mode=audio && !occupied ? PaddleInputAudio : [_source isEqual:@"vband"] ? PaddleInputVBand : PaddleInputOff;
    if (_engine.inputMode==mode && (!occupied || [_phase isEqual:@"occupied"])) return;
    [self disarm]; [self usbContacts:0]; _engine.inputMode=mode;
    _outputLabel=nil; _calibration=InputInactive; _sampling=NO;
    _phase=occupied ? @"occupied" : @"waiting";
    _detail=occupied ? @"Quit the previous Morse Paddle app to use the audio converter here." :
        mode==PaddleInputVBand ? @"Preparing VBand sidetone output…" :
        mode==PaddleInputAudio ? @"Checking the audio converter…" : @"Hardware paddle input is off.";
    [self status];
}
- (void)status {
    // Audio already renders independently. Drain its events promptly while a
    // paddle is ready, and let the helper sleep longer while awaiting hardware.
    NSTimeInterval interval=[_phase isEqual:@"ready"] ? .005 : .05;
    if (!_eventTimer || _eventTimer.timeInterval!=interval) {
        [_eventTimer invalidate];
        __weak PaddleService *weak=self;
        _eventTimer=[NSTimer timerWithTimeInterval:interval repeats:YES block:^(NSTimer *t){ (void)t; [weak tick]; }];
        [[NSRunLoop mainRunLoop] addTimer:_eventTimer forMode:NSRunLoopCommonModes];
    }
    ToneSettings t=_engine.toneSettings;
    emit(@{@"type":@"status",@"source":_source ?: @"off",@"epoch":@(_engine.elementEpoch),@"phase":_phase ?: @"waiting",@"detail":_detail ?: @"Checking paddle adapter",
        @"outputs":_outputs ?: @[],@"playing":_outputLabel ?: @"",@"output":_engine.outputChoice,
        @"outputReady":@([_outputLabel hasPrefix:@"Output"]),@"volume":@(_engine.sidetoneVolume),@"reverse":@(_engine.paddlesSwapped),@"hasReverse":@([_prefs objectForKey:@"paddlesSwapped"]!=nil ? YES : NO),@"pitch":@(t.pitchHz),
        @"rise":@(t.riseMs),@"fall":@(t.fallMs),@"curve":@(t.curve),@"wordSpaces":((t.options & TimedWordSpaces) ? @YES : @NO),
        @"wpm":@(t.wpm),@"spacing":@(effectiveWPM(t)),@"sharedSound":@([_prefs boolForKey:@"sharedSound"]),
        @"hasTone":@([_prefs dictionaryForKey:@"sidetoneSettings"]!=nil),@"hasVolume":@([_prefs objectForKey:@"sidetoneVolume"]!=nil),
        @"legacyWpm":[_prefs objectForKey:@"legacyWpm"] ?: @0,@"calibration":@(_calibration),
        @"sampling":@(_sampling),@"typing":@(_typingEnabled),@"canArm":@([self canArm]),@"typingIssue":_typingIssue ?: @""});
}
- (void)tick {
    if (_controlSince && NSProcessInfo.processInfo.systemUptime-_controlSince>=10) {
        [self usbContacts:0]; [self disarm]; [_engine interruptInput];
    }
    unsigned epoch=_engine.elementEpoch;
    if (epoch!=_epoch) {
        [self disarm]; _epoch=epoch=_engine.elementEpoch; emit(@{@"type":@"reset",@"epoch":@(epoch)}); [self status];
    }
    ElementEvent e;
    while ([_engine takeElement:&e]) {
        if (e.epoch!=epoch || epoch!=_engine.elementEpoch) continue;
        emit(@{@"type":@"element",@"epoch":@(epoch),@"seq":@(++_sequence),@"kind":@(e.kind),@"frame":@(e.frame),@"rate":@(e.rate)});
    }
    if (!_typingEnabled) return;
    if (![self canArm] || ![self hasTypingAccess]) { [self disarm]; [self status]; return; }
    pid_t front=[self focusedTypingPID];
    if (front!=_target) [self followPID:front];
    if (!_target) return;
    [_engine drainTypedCharacters:^(pid_t pid,char c,BOOL space) {
        if (space && [self stillTypingTo:pid]) [self postKey:' ' toPID:pid];
        if ([self stillTypingTo:pid]) [self postKey:c toPID:pid];
    }];
}
- (void)focusChanged:(NSNotification *)note {
    if (!_typingEnabled || !_target) return;
    NSRunningApplication *app=note.userInfo[NSWorkspaceApplicationKey];
    BOOL left=[note.name isEqual:NSWorkspaceDidDeactivateApplicationNotification];
    if ((left && app.processIdentifier==_target) || (!left && app.processIdentifier!=_target))
        [self clearTypingTarget];
}
- (NSDictionary *)command:(NSDictionary *)m {
    NSString *op=m[@"op"]; id value=m[@"value"];
    if ([op isEqual:@"input"]) {
        if (![@[@"paddle",@"vband",@"off"] containsObject:value]) return @{@"error":@"Unknown input."};
        if (![_source isEqual:value]) {
            [self disarm]; [self usbContacts:0]; _source=[value copy]; [self reconcileInput];
            if ([_source isEqual:@"off"]) { _phase=@"waiting"; _detail=@"Hardware paddle input is off."; }
        }
    } else if ([op isEqual:@"vband"]) {
        if (![_source isEqual:@"vband"] || ![_phase isEqual:@"ready"] || ![_outputLabel hasPrefix:@"Output"] || _typingEnabled ||
            ![value isKindOfClass:NSDictionary.class] || ![value[@"mask"] isKindOfClass:NSNumber.class] ||
            ![value[@"epoch"] isEqual:@(_engine.elementEpoch)] || [value[@"mask"] unsignedIntValue]>3)
            return @{@"error":@"VBand input was interrupted."};
        [self usbContacts:[value[@"mask"] unsignedIntValue]];
    } else if ([op isEqual:@"vband-release"]) {
        if ([_source isEqual:@"vband"] && !_typingEnabled) { [self usbContacts:0]; [_engine interruptInput]; }
    } else if ([op isEqual:@"status"]) [self status];
    else if ([op isEqual:@"disarm"]) { [self disarm]; [self status]; }
    else if ([op isEqual:@"arm"]) {
        if (value || ![self canArm]) return @{@"error":@"Connect a ready paddle and finish calibration before enabling typing."};
        if (_typingEnabled) return @{};
        if (![self hasTypingAccess]) {
            CGRequestPostEventAccess();
            return @{@"error":@"Allow Morse in Privacy & Security → Accessibility, then enable typing again."};
        }
        [self clearTypingTarget];
        [_engine interruptInput]; [self tick];
        _typingIssue=nil; _typingEnabled=YES; _engine.sidetoneMuted=NO;
    } else if ([op isEqual:@"interrupt"]) {
        [self disarm]; [self usbContacts:0]; [_engine interruptInput]; _engine.sidetoneMuted=NO;
    } else if ([op isEqual:@"mute"]) { [self tick]; _engine.sidetoneMuted=[value boolValue] && !_typingEnabled; }
    else if ([op isEqual:@"keyer"] || [op isEqual:@"sound"]) {
        ToneSettings t=_engine.toneSettings;
        t.wpm=[value[@"wpm"] unsignedIntValue]; t.spacingWpm=[value[@"farnsworth"] unsignedIntValue];
        t.options=TrainerGapThresholds | (t.options & TimedWordSpaces) | (t.spacingWpm<t.wpm ? UseFarnsworth : 0) |
            ([value[@"keyer"] isEqual:@"b"] ? IambicModeB : 0);
        if (t.wpm<MinKeyerWPM || t.wpm>MaxKeyerWPM || t.spacingWpm<MinSpacingWPM || t.spacingWpm>t.wpm) return @{@"error":@"Invalid speed."};
        ToneSettings previous=_engine.toneSettings;
        if (memcmp(&t,&previous,sizeof(t))) { [self disarm]; [_engine interruptInput]; }
        if ([op isEqual:@"sound"]) {
            t.pitchHz=[value[@"pitch"] unsignedIntValue]; t.riseMs=[value[@"rise"] unsignedIntValue];
            t.fallMs=[value[@"fall"] unsignedIntValue]; t.curve=[value[@"curve"] unsignedIntValue];
            _engine.sidetoneVolume=[value[@"volume"] unsignedIntValue];
            [_prefs setObject:@(_engine.sidetoneVolume) forKey:@"sidetoneVolume"];
        }
        _engine.toneSettings=t;
        if ([op isEqual:@"sound"]) [_prefs setBool:YES forKey:@"sharedSound"];
    } else if ([op isEqual:@"word-spaces"]) {
        ToneSettings t=_engine.toneSettings;
        if ([value boolValue]) t.options|=TimedWordSpaces; else t.options &= ~TimedWordSpaces;
        _engine.toneSettings=t;
    } else if ([op isEqual:@"calibrate"] || [op isEqual:@"automatic"] || [op isEqual:@"cancelCalibration"]) {
        if (_engine.inputMode!=PaddleInputAudio) return @{@"error":@"Select the audio converter to calibrate."};
        [self disarm]; [_engine interruptInput];
        if ([op isEqual:@"calibrate"]) [_engine beginInputCalibration];
        else if ([op isEqual:@"automatic"]) [_engine useAutomaticInputLevels];
        else [_engine cancelInputCalibration];
    } else if ([op isEqual:@"sample"]) {
        if (_engine.inputMode!=PaddleInputAudio) return @{@"error":@"Select the audio converter to calibrate."};
        [_engine sampleInputCalibrationBoosted:[value boolValue]];
    }
    else if ([op isEqual:@"reverse"]) { [self disarm]; [_engine interruptInput]; _engine.paddlesSwapped=[value boolValue]; }
    else if ([op isEqual:@"volume"]) { _engine.sidetoneVolume=[value unsignedIntValue]; [_prefs setObject:@(_engine.sidetoneVolume) forKey:@"sidetoneVolume"]; }
    else if ([op isEqual:@"output"]) {
        if (![@[@"auto",@"speakers"] containsObject:value] && ![[_outputs valueForKey:@"id"] containsObject:value]) return @{@"error":@"Output unavailable."};
        [self disarm]; [_engine interruptInput]; _engine.outputChoice=value; [_prefs setObject:value forKey:@"sidetoneOutput"];
    } else if ([op isEqual:@"envelope"]) {
        ToneSettings t=_engine.toneSettings;
        t.pitchHz=[value[@"pitch"] unsignedIntValue]; t.riseMs=[value[@"rise"] unsignedIntValue];
        t.fallMs=[value[@"fall"] unsignedIntValue]; t.curve=[value[@"curve"] unsignedIntValue];
        if ([value[@"wordSpaces"] boolValue]) t.options|=TimedWordSpaces; else t.options &= ~TimedWordSpaces;
        _engine.toneSettings=t;
    } else return @{@"error":@"Unknown paddle command."};
    if (![@[@"mute",@"status",@"keyer",@"vband",@"vband-release"] containsObject:op]) [self status];
    return @{};
}
@end

#ifndef MORSE_SERVICE_NO_MAIN
int main(int argc,const char **argv) {
    @autoreleasepool {
        if (argc!=3) return 2;
        signal(SIGPIPE,SIG_IGN);
        BOOL isolated=strcmp(argv[2],"app")!=0;
        NSDictionary *legacy=isolated ? nil : [NSUserDefaults.standardUserDefaults persistentDomainForName:@"is.kubbur.morsepaddle"];
        PaddleService *host=[PaddleService new]; host.isolated=isolated;
        host.prefs=[[DevicePreferences alloc] initWithDirectory:[NSURL fileURLWithPath:@(argv[1]) isDirectory:YES] legacy:legacy error:nil];
        if (!host.prefs) return 3;
        host.engine=[[MorseEngine alloc] initWithDefaults:host.prefs];
        host.source=@"off"; host.engine.inputMode=PaddleInputOff;
        id out=[host.prefs objectForKey:@"sidetoneOutput"], vol=[host.prefs objectForKey:@"sidetoneVolume"];
        host.engine.outputChoice=[out isKindOfClass:NSString.class] ? out : @"auto";
        if ([vol isKindOfClass:NSNumber.class]) host.engine.sidetoneVolume=MAX(0,MIN(100,[vol intValue]));
        __weak PaddleService *weak=host;
        host.engine.stateChanged=^(NSString *phase,NSString *detail,unsigned mask,double time,BOOL swapped) {
            (void)mask; (void)time; (void)swapped;
            if (![phase isEqual:@"ready"]) [weak disarm];
            if (![phase isEqual:weak.phase] || ![detail isEqual:weak.detail]) { weak.phase=phase; weak.detail=detail; [weak status]; }
        };
        host.engine.outputsChanged=^(NSArray *devices,NSString *playing) { if (![playing hasPrefix:@"Output"]) [weak disarm]; weak.outputs=devices; weak.outputLabel=playing; [weak status]; };
        host.engine.inputCalibrationChanged=^(PaddleCalibrationStep step,BOOL sampling,BOOL boosted) {
            (void)boosted; weak.calibration=step; weak.sampling=sampling; [weak disarm]; [weak status];
        };
        for (NSNotificationName name in @[NSWorkspaceDidDeactivateApplicationNotification, NSWorkspaceDidActivateApplicationNotification])
            [NSWorkspace.sharedWorkspace.notificationCenter addObserver:host selector:@selector(focusChanged:) name:name object:nil];
        if (!isolated) {
            host.active=YES; [host.engine start];
            [NSTimer scheduledTimerWithTimeInterval:.5 repeats:YES block:^(NSTimer *t){ (void)t; [host reconcileInput]; }];
        }
        [host status];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
            char line[8192];
            while (fgets(line,sizeof(line),stdin)) @autoreleasepool {
                if (!strchr(line,'\n')) break;
                NSData *data=[NSData dataWithBytes:line length:strlen(line)];
                NSDictionary *msg=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                if (![msg isKindOfClass:NSDictionary.class] || ![msg[@"id"] isKindOfClass:NSNumber.class]) break;
                dispatch_sync(dispatch_get_main_queue(),^{
                    @try { emit(@{@"type":@"reply",@"id":msg[@"id"],@"value":[host command:msg]}); }
                    @catch (NSException *exception) { (void)exception; emit(@{@"type":@"reply",@"id":msg[@"id"],@"value":@{@"error":@"Paddle settings could not be saved."}}); }
                });
            }
            dispatch_async(dispatch_get_main_queue(),^{ [host disarm]; if (host.active) [host.engine stop]; exit(0); });
        });
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
#endif
