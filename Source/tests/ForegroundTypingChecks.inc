// Use the real decoder and queue. Substitute the workspace, permission, tap
// and event sink so this check cannot observe or type into any personal app.
@interface MorseEngine (TypingTestQueue)
- (TypingQueue *)testTypingQueue;
@end
@implementation MorseEngine (TypingTestQueue)
- (TypingQueue *)testTypingQueue { return &_typing; }
@end

@interface ForegroundFixture : PaddleService
@property pid_t front;
@property BOOL access, tapFails;
@property unsigned controls;
@property (copy) void (^contact)(unsigned);
@property (copy) void (^tapStopped)(void);
@property (strong) NSMutableString *sent;
@end
@implementation ForegroundFixture
- (void)status {}
- (pid_t)focusedTypingPID { return _front; }
- (BOOL)hasTypingAccess { return _access; }
- (unsigned)heldVBandControls { return _controls; }
- (VBandTarget *)watchPID:(pid_t)pid contacts:(void (^)(unsigned))contacts stopped:(void (^)(void))stopped {
    (void)pid; self.contact=contacts; self.tapStopped=stopped;
    return _tapFails ? nil : [VBandTarget new];
}
- (void)postKey:(char)c toPID:(pid_t)pid { [_sent appendFormat:@"%d/%c ",pid,c]; }
@end

static bool checkForegroundTyping(void) {
    ForegroundFixture *host=[ForegroundFixture new];
    host.engine=[[MorseEngine alloc] initWithDefaults:nil];
    host.phase=@"ready"; host.outputLabel=@"Output test"; host.source=@"paddle";
    host.sent=[NSMutableString string]; host.access=YES;
    Keyer key={0}; configureKeyer(&key,48000,30);
    key.typing=host.engine.testTypingQueue;
    UInt32 unit=(UInt32)key.unitFrames;
    host.front=41; [host tick]; keyFrames(&key,unit,false); sendLetter(&key,".",4,false);
    [host tick]; REQUIRE(!host.sent.length);
    host.front=0; REQUIRE(![host command:@{@"op":@"arm"}][@"error"]);
    REQUIRE(host.typingEnabled && !host.target);
    host.front=41; [host tick]; keyFrames(&key,unit,false);
    sendLetter(&key,".",4,false); [host tick]; REQUIRE([host.sent isEqual:@"41/e "]);
    // A completed but undelivered letter and a partial mark stay behind on switch.
    sendLetter(&key,"-",4,false); tap(&key,1,unit,false); host.front=42; [host tick];
    keyFrames(&key,8*unit,false); [host tick]; REQUIRE([host.sent isEqual:@"41/e "]);
    sendLetter(&key,"-",4,false); [host tick]; REQUIRE([host.sent isEqual:@"41/e 42/t "]);
    setPaddles(&key,1); keyFrames(&key,3*unit,false); host.front=41; [host tick];
    keyFrames(&key,4*unit,false); setPaddles(&key,0); keyFrames(&key,8*unit,false);
    [host tick]; REQUIRE([host.sent isEqual:@"41/e 42/t "]);
    host.front=0; [host tick]; REQUIRE(host.typingEnabled && !host.target);
    host.front=42; [host tick]; keyFrames(&key,unit,false);
    sendLetter(&key,".",4,false); host.access=NO; [host tick];
    REQUIRE(!host.typingEnabled && !host.target && [host.sent isEqual:@"41/e 42/t "]);
    host.access=YES; host.front=41; [host tick]; REQUIRE(!host.typingEnabled);
    host.calibration=InputBoth; REQUIRE([host command:@{@"op":@"arm"}][@"error"]);
    host.calibration=InputInactive;
    REQUIRE((![host command:@{@"op":@"input",@"value":@"vband"}][@"error"]));
    host.phase=@"ready"; host.outputLabel=@"Output test";
    REQUIRE(![host command:@{@"op":@"arm"}][@"error"]);
    host.controls=1; [host tick];
    ContactQueue *queue=host.engine.vbandContactQueue;
    void (^stale)(unsigned)=[host.contact copy]; void (^stopped)(void)=[host.tapStopped copy];
    stale(1); REQUIRE(!atomic_load(&queue->mask)); stale(0); stale(2); REQUIRE(atomic_load(&queue->mask)==2);
    host.front=42; [host tick]; REQUIRE(!atomic_load(&queue->mask));
    host.front=41; [host tick]; stale(3); stopped(); REQUIRE(host.typingEnabled && !atomic_load(&queue->mask));
    host.contact(0); host.contact(1); REQUIRE(atomic_load(&queue->mask)==1);
    [host.engine interruptInput]; [host tick]; REQUIRE(!host.typingEnabled && !host.target && !atomic_load(&queue->mask));
    REQUIRE(![host command:@{@"op":@"arm"}][@"error"]);
    host.tapFails=YES; [host tick]; REQUIRE(!host.typingEnabled && host.typingIssue.length);
    return true;
}
