#import "../MorseEngine.m"
#import "../PaddleBridge.h"
#include "PCMChecks.inc"
#include "TypingChecks.inc"
#include "ControlChecks.inc"
#include "InputChecks.inc"

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
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc==4 && !strcmp(argv[1],"--preferences")) return checkPreferences(argv[2],argv[3]);
        SoundOutput *mac=option(11,@"MacBook Air Speakers",NO),*pods=option(12,@"AirPods Pro",YES);
        SoundOutput *renamed=option(13,@"Kris’s headphones",YES);
        NSArray *all=@[mac,pods,renamed];
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"Failed check at line %d\n",__LINE__); return 1; } } while (0)
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
            Detector d={0}; Generator g={0}; unsigned noise=42; synth(&d,&g,hz,0,SettleBlocks+IdleBlocks+10,&noise);
            int masks[]={1,3,2,0,2,0};
            for (size_t j=0; j<sizeof(masks)/sizeof(*masks); ++j) { synth(&d,&g,hz,masks[j],8,&noise); CHECK(d.stable==masks[j]); }
        }
        CHECK(checkTextEvents());
        makeTables(22050); CHECK(checkMovementInput(22050));
        puts("Input checks passed: independent paddle edges, 40 ms taps, sustained movement, held squeeze, overlap rejection, bad idle calibration and isolated +6 dB wired drive.");
        puts("Controls passed: reversed adapter typing, deliberate word spaces, Farnsworth boundaries, 5–60 WPM, pitch and all envelope shapes at three sample rates.");
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
                    synth(&d,&g,48000,0,SettleBlocks+IdleBlocks+10,&noise);
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
                else if (line[0]>='0' && line[0]<='3') synth(&d,&g,48000,line[0]-'0',6,&noise);
                else break;
            }
            [bridge stop]; exit(0);
        });
        dispatch_main();
    }
}
