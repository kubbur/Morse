#import "../MorseEngine.m"
#define MORSE_SERVICE_NO_MAIN
#import "../PaddleService.m"
#import "../PaddleBridge.h"
#include "PCMChecks.inc"
#include "TypingChecks.inc"
#include "ControlChecks.inc"
#include "ForegroundTypingChecks.inc"
#include "InputChecks.inc"

// Keep the test process disconnected from devices and the external typing tap.
@interface FixturePaddleService : PaddleService
@end
@implementation FixturePaddleService
- (void)status {} // Vector output is a single JSON result.
@end

static SoundOutput *option(unsigned device, NSString *name, BOOL bluetooth) {
    SoundOutput *o=[SoundOutput new]; o.route=(Route){.dev=device,.channels=2,.alive=true,
        .transport=bluetooth ? kAudioDeviceTransportTypeBluetooth : kAudioDeviceTransportTypeBuiltIn};
    o.name=name; o.uid=[NSString stringWithFormat:@"uid-%u",device]; o.bluetooth=bluetooth; return o;
}
static void printEvent(void *context, unsigned mask, bool swapped) {
    (void)swapped;
    PaddleBridge *bridge=(__bridge PaddleBridge *)context;
    [bridge publish:@"ready" mask:mask timeMs:monotonicSeconds()*1000];
}
// Deterministic contact fixtures exercise the same render path as Core Audio.
// Return sample-clock edges, decoded text and a count of nonzero PCM frames.
static int vector(unsigned wpm, bool modeB, NSString *contacts, BOOL usb, BOOL reverse) {
    if (wpm<MinKeyerWPM || wpm>MaxKeyerWPM) return 2;
    Keyer key={0}; TypingQueue typing={0}; ElementStream stream={0};
    const double rate=48000; configureKeyer(&key,rate,wpm);
    MorseEngine *adapter=nil;
    PaddleService *service=nil;
    if (usb) {
        IsolatedDefaults *defaults=[[IsolatedDefaults alloc] initWithSuiteName:NSUUID.UUID.UUIDString];
        [defaults setVolatileDomain:@{} forName:NSArgumentDomain];
        adapter=[[MorseEngine alloc] initWithDefaults:defaults];
        service=[FixturePaddleService new]; service.isolated=YES; service.engine=adapter;
        if ([service command:@{@"op":@"input",@"value":@"vband"}][@"error"]) return 4;
        service.phase=@"ready"; service.outputLabel=@"Output · simulated";
        adapter.paddlesSwapped=reverse;
        key.contacts=adapter.vbandContactQueue;
    }
    key.stream=&stream; initTypingQueue(&typing); selectTypingDestination(&typing,42);
    key.typing=&typing; key.initialSettings.options=TrainerGapThresholds|TimedWordSpaces; if (modeB) key.initialSettings.options|=IambicModeB;
    float pcm[128]; renderKeyer(&key,1,pcm);
    NSMutableArray *edges=[NSMutableArray array]; NSMutableString *typed=[NSMutableString string];
    NSMutableData *wave=[NSMutableData data];
    unsigned audible=0; uint64_t cursor=0, plannedEnd=0;
    NSArray *rows=[contacts componentsSeparatedByString:@","];
    uint64_t end=0;
    for (NSUInteger i=0;i<=rows.count;i++) {
        NSArray *parts=i<rows.count ? [rows[i] componentsSeparatedByString:@":"] : nil;
        if (parts && parts.count!=2) return 2;
        uint64_t until=parts ? (uint64_t)llround([parts[0] doubleValue]*rate/1000) : end+(uint64_t)(rate*3);
        if (until<cursor || until>rate*20) return 2;
        while (cursor<until) {
            unsigned n=(unsigned)MIN(128,until-cursor); renderKeyer(&key,n,pcm);
            [wave appendBytes:pcm length:n*sizeof(float)];
            for (unsigned j=0;j<n;j++) if (fabs(pcm[j])>0.0001) audible++;
            cursor+=n; ElementEvent e;
            while (takeElement(&stream,&e)) if (e.kind) {
                if (e.kind==1) plannedEnd=e.frame+e.frames;
                else if (e.frame!=plannedEnd) return 3;
                [edges addObject:@{@"down":(e.kind==1 ? @YES : @NO),@"at":@((e.frame-1)*1000.0/rate)}];
            }
        }
        if (parts) {
            unsigned mask=(unsigned)[parts[1] intValue];
            if (mask>3) return 2;
            if (usb) {
                NSDictionary *value=@{@"mask":@(mask),@"epoch":@(adapter.elementEpoch)};
                if ([service command:@{@"op":@"vband",@"value":value}][@"error"]) return 4;
            } else setPaddles(&key,mask);
            end=until;
        }
    }
    // Independently measure the PCM in every scored mark and every gap.
    const float *samples=wave.bytes;
    uint64_t last=0, count=wave.length/sizeof(float);
    if (edges.count%2) return 3;
    for (NSUInteger i=0;i<edges.count;i+=2) {
        uint64_t start=(uint64_t)llround([edges[i][@"at"] doubleValue]*rate/1000);
        uint64_t stop=(uint64_t)llround([edges[i+1][@"at"] doubleValue]*rate/1000);
        if (start<last || stop<=start || stop>count) return 3;
        for (;last<start;last++) if (samples[last]!=0) return 3;
        unsigned sounding=0;
        for (;last<stop;last++) if (fabs(samples[last])>.0001) sounding++;
        if (sounding<(stop-start)*.85) return 3;
    }
    for (;last<count;last++) if (samples[last]!=0) return 3;
    TypedCharacter event; while (takeTypedCharacter(&typing,&event)) { if (event.spaceBefore) [typed appendString:@" "]; [typed appendFormat:@"%c",event.character]; }
    NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"edges":edges,@"typed":typed,@"audible":@(audible)} options:0 error:nil];
    fwrite(data.bytes,1,data.length,stdout); return 0;
}
#include "WiredLatencyChecks.inc"

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc==5 && (!strcmp(argv[1],"--vector") || !strcmp(argv[1],"--vband") || !strcmp(argv[1],"--vband-reversed")))
            return vector((unsigned)atoi(argv[2]),!strcmp(argv[3],"b"),@(argv[4]),strcmp(argv[1],"--vector")!=0,!strcmp(argv[1],"--vband-reversed"));
        if (argc==2 && !strcmp(argv[1],"--input-latency")) return inputLatency();
        if (argc==2 && !strcmp(argv[1],"--detector-cost")) { detectorCost(); return 0; }
        if (argc==4 && !strcmp(argv[1],"--preferences")) return checkPreferences(argv[2],argv[3]);
        SoundOutput *mac=option(11,@"MacBook Air Speakers",NO),*pods=option(12,@"AirPods Pro",YES);
        SoundOutput *renamed=option(13,@"Kris’s headphones",YES);
        NSArray *all=@[mac,pods,renamed];
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"Failed check at line %d\n",__LINE__); return 1; } } while (0)
        CHECK(checkForegroundTyping());
        CHECK(chooseOutput(all,@"auto",11,20,nil)==mac);
        CHECK(chooseOutput(all,@"auto",12,20,nil)==pods);
        CHECK(chooseOutput(all,@"auto",20,20,nil)==pods);
        CHECK(chooseOutput(all,@"auto",20,20,renamed.uid)==renamed);
        CHECK(chooseOutput(all,@"speakers",12,20,nil)==mac);
        CHECK(chooseOutput(all,pods.uid,11,20,nil)==pods);
        CHECK(chooseOutput(@[mac],pods.uid,11,20,nil)==nil);
        CHECK(chooseOutput(@[mac],@"auto",20,20,pods.uid)==mac);
        CHECK(chooseOutput(@[mac,pods],pods.uid,20,20,nil)==pods);
        Route bt=pods.route; strcpy(bt.uid,"airpods"); CHECK(bluetoothOutput(&bt) && !wired(&bt));
        bt.input=true; CHECK(!bluetoothOutput(&bt) && !wired(&bt));
        CHECK([[PaddleBridge originForURL:[NSURL URLWithString:@"https://TRAINER.example:443/practice"]] isEqual:@"https://trainer.example"]);
        CHECK([[PaddleBridge originForURL:[NSURL URLWithString:@"http://localhost:5173/trainer"]] isEqual:@"http://localhost:5173"]);
        CHECK(![PaddleBridge originForURL:[NSURL URLWithString:@"http://outside.example"]]);
        CHECK(![PaddleBridge originForURL:[NSURL URLWithString:@"https://someone@trainer.example"]]);
        for (int i=0;i<3;++i) {
            double hz=(double[]){44100,48000,96000}[i]; makeTables(hz); CHECK(checkKeyer(hz));
            CHECK(checkVolume(hz)); CHECK(checkTyping(hz,true)); CHECK(checkTyping(hz,false));
            CHECK(checkAdapterToText(hz,false,true)); CHECK(checkAdapterToText(hz,true,true)); CHECK(checkAdapterToText(hz,true,false));
            CHECK(checkChatSpacing(hz)); CHECK(checkControlRanges(hz));
            CHECK(checkMovementInput(hz)); CHECK(checkInputRecovery(hz)); CHECK(checkWiredBoost(hz));
            Detector d={0}; Generator g={0}; unsigned noise=42; synth(&d,&g,hz,0,SettleBlocks+IdleBlocks+10,&noise,NULL);
            int masks[]={1,3,2,0,2,0};
            for (size_t j=0; j<sizeof(masks)/sizeof(*masks); ++j) { synth(&d,&g,hz,masks[j],8,&noise,NULL); CHECK(d.stable==masks[j]); }
        }
        CHECK(checkTextEvents());
        makeTables(22050); CHECK(checkMovementInput(22050));
        for (unsigned i=0;i<6;i++) {
            double hz=(double[]){8000,22050,44100,48000,96000,384000}[i]; makeTables(hz);
            CHECK(checkInterference(hz)); CHECK(checkJackEvidence(hz)); CHECK(checkJackInterruption(hz));
            CHECK(checkJackRelease(hz));
        }
        for (unsigned i=0;i<2;i++) {
            double hz=i ? 48000 : 44100; makeTables(hz);
            double speakerRate=i ? 44100 : 48000;
            CHECK(checkJackKeying(hz,speakerRate,30,false)); CHECK(checkJackKeying(hz,speakerRate,30,true));
            CHECK(checkJackKeying(hz,speakerRate,5,false)); CHECK(checkJackKeying(hz,speakerRate,60,false));
        }
        puts("Jack checks passed: clean presses and releases, weak calibrated signals, interference, holds across clock changes, A/R and separate rapid taps.");
        puts("Input checks passed: independent paddle edges, 40 ms taps, sustained movement, held squeeze, overlap rejection, bad idle calibration and isolated +6 dB wired drive.");
        puts("Controls passed: reversed adapter typing, deliberate word spaces, Farnsworth boundaries, 5–80 WPM, pitch and all envelope shapes at three sample rates.");
        puts("Typing and volume checks passed: exact Morse gaps, focus changes, held and squeezed paddles, silent keying, native Unicode events and independent stereo gain at three sample rates.");
        puts("Audio checks passed: automatic selection, manual speakers/AirPods, fallback/reconnect, native PCM and all four paddle states."); fflush(stdout);
        if (argc!=3 || strcmp(argv[1],"--test-server")) return 0;
        NSURL *resources=[NSURL fileURLWithPath:@(argv[2]) isDirectory:YES];
        PaddleBridge *bridge=[[PaddleBridge alloc] initWithResources:resources port:0];
        MorseEngine *engine=[[MorseEngine alloc] initWithDefaults:[[IsolatedDefaults alloc] initWithSuiteName:NSUUID.UUID.UUIDString]];
        engine.sidetoneVolume=64;
        bridge.sidetoneMuteChanged=^(BOOL muted) { engine.sidetoneMuted=muted; };
        [bridge allowOrigin:@"https://trainer.example"];
        NSError *error=nil; CHECK([bridge start:&error]);
        printf("LISTENING %s\n",bridge.localURL.absoluteString.UTF8String); fflush(stdout);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
            atomic_bool swap; atomic_init(&swap,false);
            makeTables(48000); Detector d={.change=printEvent,.context=(__bridge void *)bridge,.swapRequested=&swap};
            Generator g={0}; unsigned noise=42; char line[32];
            while (fgets(line,sizeof(line),stdin)) @autoreleasepool {
                if (!strncmp(line,"calibrate",9)) {
                    [bridge publish:@"calibrating" mask:0 timeMs:monotonicSeconds()*1000];
                    synth(&d,&g,48000,0,SettleBlocks+IdleBlocks+10,&noise,NULL);
                } else if (!strncmp(line,"swap",4)) atomic_store(&swap,!atomic_load(&swap));
                else if (!strncmp(line,"speed ",6)) {
                    unsigned speed=0,effective=0;
                    if (sscanf(line+6,"%u %u",&speed,&effective)==2) [bridge setKeyerWPM:speed effective:effective];
                } else if (!strncmp(line,"queued",6)) [bridge publish:@"ready" mask:3 timeMs:paddleTimeMs()-30000];
                else if (!strncmp(line,"offline",7)) [bridge publish:@"disconnected" mask:0 timeMs:monotonicSeconds()*1000];
                else if (!strncmp(line,"revoke",6)) [bridge allowOrigin:nil];
                else if (!strncmp(line,"relink",6)) [bridge allowOrigin:@"https://trainer.example"];
                else if (!strncmp(line,"local-unmute",12)) [bridge unmuteSidetone];
                else if (!strncmp(line,"level",5)) {
                    printf("SIDETONE %u %u\n",(unsigned)engine.sidetoneMuted,engine.sidetoneVolume); fflush(stdout);
                }
                else if (line[0]>='0' && line[0]<='3') synth(&d,&g,48000,line[0]-'0',6,&noise,NULL);
                else break;
            }
            [bridge stop]; exit(0);
        });
        dispatch_main();
    }
}
