static bool checkChatSpacing(double rate) {
    TypingQueue q={0}; initTypingQueue(&q); selectTypingDestination(&q,42);
    Keyer k={0}; configureKeyer(&k,rate,30); k.typing=&q;
    UInt32 unit=(UInt32)lround(k.unitFrames); keyFrames(&k,unit,false);
    // The operator pauses two seconds between each character and sends an explicit word break.
    const char *message[]={"....","..",".-.-","-","....",".",".-.","."};
    for (unsigned i=0;i<sizeof(message)/sizeof(message[0]);i++) sendLetter(&k,message[i],50,false);
    REQUIRE(expectText(&q,"hi there"));
    // The same command can insert a space after text already entered on the physical keyboard.
    selectTypingDestination(&q,43); keyFrames(&k,unit,false);
    sendLetter(&k,".-.-",9,false); REQUIRE(expectText(&q," "));
    k.initialSettings.options=UseFarnsworth|TimedWordSpaces;
    double gap=(60000.0/12-31*40)/19;
    REQUIRE(fabs(spacingUnitMs(k.initialSettings)-gap)<1e-9);
    REQUIRE(fabs(31*40+19*gap-5000)<1e-8);
    UInt32 letter=(UInt32)llround(3*rate*gap/1000), word=(UInt32)llround(7*rate*gap/1000);
    tap(&k,1,unit,false); keyFrames(&k,letter-1,false); REQUIRE(expectText(&q,""));
    keyFrames(&k,1,false); REQUIRE(expectText(&q,"e"));
    keyFrames(&k,word-letter-1,false); tap(&k,2,3*unit,false); keyFrames(&k,letter,false);
    REQUIRE(expectText(&q,"t"));
    keyFrames(&k,word-letter,false); tap(&k,1,unit,false); keyFrames(&k,letter,false); REQUIRE(expectText(&q," e"));
    keyFrames(&k,word,false); sendLetter(&k,".-.-",0,false); keyFrames(&k,word,false);
    tap(&k,1,unit,false); keyFrames(&k,letter,false); REQUIRE(expectText(&q," e"));
    k.initialSettings.options=UseFarnsworth;
    keyFrames(&k,word,false); tap(&k,2,3*unit,false); keyFrames(&k,word*2,false); REQUIRE(expectText(&q,"t"));
    tap(&k,1,unit,false); keyFrames(&k,letter,false); REQUIRE(expectText(&q,"e"));
    selectTypingDestination(&q,44); keyFrames(&k,unit,false);
    k.initialSettings.options=UseFarnsworth|TimedWordSpaces|TrainerGapThresholds;
    // A gap longer than five dits can still be a letter gap at slow spacing.
    tap(&k,1,unit,false); keyFrames(&k,6*unit,false);
    tap(&k,1,unit,false); keyFrames(&k,(UInt32)ceil(5*rate*gap/1000),false);
    tap(&k,2,3*unit,false); keyFrames(&k,2*unit,false); REQUIRE(expectText(&q,"ee t"));
    return true;
}
static bool checkConfiguredTone(double rate, ToneSettings t, unsigned element) {
    AtomicToneSettings config; atomic_init(&config,t); REQUIRE(atomic_is_lock_free(&config));
    Keyer k={0}; configureKeyer(&k,rate,30); k.settings=&config; setPaddles(&k,element); setPaddles(&k,0);
    UInt32 frames=(UInt32)lround(rate*1.2*(element==1 ? 1 : 3)/t.wpm);
    UInt32 rise=(UInt32)lround(rate*t.riseMs/1000), fall=(UInt32)lround(rate*t.fallMs/1000);
    if (rise+fall>frames-1) {
        rise=(UInt32)lround((double)(frames-1)*rise/(rise+fall)); fall=frames-1-rise;
    }
    for (UInt32 offset=0;offset<frames;) {
        float samples[173]; UInt32 n=MIN(173u,frames-offset);
        AudioBufferList buffer={1,{{1,n*sizeof(float),samples}}};
        REQUIRE(speakerRender(&k,NULL,NULL,0,n,&buffer)==noErr);
        for (UInt32 i=0;i<n;i++) {
            UInt32 p=offset+i;
            double x=fmin(1,fmin((double)p/rise,(double)(frames-1-p)/fall));
            double envelope=t.curve==LinearRamp ? x : (t.curve==ExponentialRamp ?
                (exp(3*x)-1)/(exp(3)-1) : pow(sin(M_PI_2*x),2));
            double expected=.2*envelope*sin(2*M_PI*t.pitchHz*p/rate);
            REQUIRE(fabs(samples[i]-expected)<.00001);
        }
        offset+=n;
    }
    REQUIRE(k.markLength==frames && k.markLeft==0);
    REQUIRE(fabs(k.gapLeft-rate*1.2/t.wpm)<=1);
    return true;
}
static bool checkControlRanges(double rate) {
    ToneSettings t=defaultToneSettings;
    for (unsigned i=0;i<3;i++) {
        t.wpm=(uint8_t[]){5,37,60}[i]; t.pitchHz=(uint16_t[]){200,817,2000}[i];
        t.riseMs=(uint8_t[]){1,19,30}[i]; t.fallMs=(uint8_t[]){30,2,30}[i]; t.curve=(uint8_t)i;
        REQUIRE(checkConfiguredTone(rate,t,1)); REQUIRE(checkConfiguredTone(rate,t,2));
    }
    ToneSettings fastest=t; fastest.wpm=MaxKeyerWPM; fastest.spacingWpm=MinSpacingWPM; fastest.options=UseFarnsworth;
    REQUIRE(checkConfiguredTone(rate,fastest,1)); REQUIRE(checkConfiguredTone(rate,fastest,2));
    REQUIRE(fabs(31*(1200./80)+19*spacingUnitMs(fastest)-60000)<1e-7);
    AtomicToneSettings config; atomic_init(&config,defaultToneSettings);
    Keyer k={0}; configureKeyer(&k,rate,30); k.settings=&config;
    UInt32 dot=(UInt32)lround(rate*.04); setPaddles(&k,1); keyFrames(&k,1,true);
    atomic_store(&config,t); keyFrames(&k,dot-1,true); REQUIRE(k.markLength==dot && k.gapLeft==dot);
    keyFrames(&k,dot,true); keyFrames(&k,1,true); REQUIRE(k.markLength==(UInt32)lround(rate*.02));
    REQUIRE(fabs(k.phaseStep-2*M_PI*2000/rate)<1e-12); return true;
}
// Keep this restart check isolated from the user's live copy and preference daemon.
@interface IsolatedDefaults : NSUserDefaults
@end
@implementation IsolatedDefaults
- (void)setObject:(id)value forKey:(NSString *)key {
    NSMutableDictionary *values=[[self volatileDomainForName:NSArgumentDomain] mutableCopy];
    values[key]=value; [self setVolatileDomain:values forName:NSArgumentDomain];
}
- (void)setBool:(BOOL)value forKey:(NSString *)key { [self setObject:@(value) forKey:key]; }
- (void)removeObjectForKey:(NSString *)key { [self setObject:nil forKey:key]; }
@end
static int checkPreferences(const char *file, const char *operation) {
    NSURL *url=[NSURL fileURLWithPath:@(file)];
    NSUserDefaults *defaults=[[IsolatedDefaults alloc] initWithSuiteName:NSUUID.UUID.UUIDString];
    [defaults setVolatileDomain:[NSDictionary dictionaryWithContentsOfURL:url] ?: @{} forName:NSArgumentDomain];
    MorseEngine *engine=[[MorseEngine alloc] initWithDefaults:defaults]; ToneSettings t=engine.toneSettings;
    NSArray *devices=@[@"wired-mic-A",@"wired-output-A"];
    InputProfile saved=[engine inputProfileForDevices:devices];
    if (!strcmp(operation,"fresh")) return saved.on[0]!=0 || saved.boosted || engine.paddlesSwapped || engine.sidetoneMuted || memcmp(&t,&defaultToneSettings,sizeof(t));
    if (!strcmp(operation,"save")) {
        engine.sidetoneMuted=YES; engine.paddlesSwapped=YES; t.pitchHz=777; t.wpm=27; t.riseMs=3; t.fallMs=9;
        t.curve=LinearRamp; t.spacingWpm=11; t.options=UseFarnsworth|TimedWordSpaces;
        engine.toneSettings=t;
        InputProfile learned={.on={.091,.083},.off={.053,.042},.boosted=true};
        [engine inputStep:InputCalibrated sampling:NO boosted:YES profile:&learned];
        return [[defaults volatileDomainForName:NSArgumentDomain] writeToURL:url atomically:YES] ? 0 : 1;
    }
    if (!strcmp(operation,"restore")) {
        InputProfile other=[engine inputProfileForDevices:@[@"wired-mic-B",@"wired-output-A"]];
        return !(!other.on[0] && !other.boosted && saved.on[0]==.091 && saved.on[1]==.083 &&
            saved.off[0]==.053 && saved.off[1]==.042 && saved.boosted && !engine.sidetoneMuted && engine.paddlesSwapped &&
            t.pitchHz==777 && t.wpm==27 && t.riseMs==3 && t.fallMs==9 && t.curve==LinearRamp &&
            effectiveWPM(t)==11 && (t.options&TimedWordSpaces));
    }
    if (!strcmp(operation,"reset-input")) {
        Session s={0}; s.detector.profile=saved; s.detector.calibrated=SettleBlocks+IdleBlocks;
        [engine handleInputRequest:AutomaticInput session:&s running:YES];
        InputProfile cleared=[engine inputProfileForDevices:devices];
        return s.generator.boosted || s.detector.calibrated || cleared.on[0] || !s.detector.waitForRelease ||
            ![[defaults volatileDomainForName:NSArgumentDomain] writeToURL:url atomically:YES];
    }
    if (!strcmp(operation,"verify-reset")) return saved.on[0]!=0 || saved.boosted || t.pitchHz!=777;
    return 1;
}
