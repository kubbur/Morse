#import "../TypingKeys.h"

#define REQUIRE(x) do { if (!(x)) { fprintf(stderr,"Typing/audio check failed at %s:%d (%s)\n",__FILE__,__LINE__,#x); return false; } } while (0)

static void keyFrames(Keyer *k, UInt32 count, bool audible) {
    float pcm[257];
    while (count) {
        UInt32 n=MIN(count,257u);
        if (audible) {
            AudioBufferList buf={1,{{1,n*sizeof(float),pcm}}};
            speakerRender(k,NULL,NULL,0,n,&buf);
        } else renderKeyer(k,n,NULL);
        count-=n;
    }
}
static void tap(Keyer *k, unsigned mask, UInt32 frames, bool audible) {
    setPaddles(k,mask); setPaddles(k,0);
    keyFrames(k,frames,audible);
}
static void sendLetter(Keyer *k, const char *code, unsigned gap, bool audible) {
    UInt32 unit=(UInt32)lround(k->unitFrames);
    for (size_t i=0; code[i]; ++i) {
        unsigned mask=code[i]=='.' ? 1u : 2u;
        tap(k,mask,unit*(mask==1 ? 1 : 3),audible);
        keyFrames(k,unit*(code[i+1] ? 1u : gap),audible);
    }
}
static bool expectText(TypingQueue *q, const char *wanted) {
    char found[128]={0}; size_t count=0;
    TypedCharacter item;
    while (takeTypedCharacter(q,&item)) {
        if (count+2>=sizeof(found)) return false;
        if (item.spaceBefore) found[count++]=' ';
        found[count++]=item.character;
    }
    if (strcmp(found,wanted)) fprintf(stderr,"Expected '%s', got '%s'\n",wanted,found);
    return strcmp(found,wanted)==0;
}
static bool checkTyping(double rate, bool audible) {
    TypingQueue q={0}; initTypingQueue(&q);
    Keyer k={0}; configureKeyer(&k,rate,30); k.typing=&q;
    k.initialSettings.options=TimedWordSpaces;
    UInt32 u=(UInt32)lround(k.unitFrames);
    sendLetter(&k,".",7,audible); REQUIRE(expectText(&q,""));
    selectTypingDestination(&q,41); keyFrames(&k,u,audible);
    tap(&k,1,u,audible); keyFrames(&k,3*u-1,audible); REQUIRE(expectText(&q,""));
    keyFrames(&k,1,audible); REQUIRE(expectText(&q,"e"));
    keyFrames(&k,4*u,audible); REQUIRE(expectText(&q,""));
    sendLetter(&k,"-",3,audible); REQUIRE(expectText(&q," t"));
    // The exact boundary at seven dits produces a word space. One frame less does not.
    keyFrames(&k,4*u-1,audible); sendLetter(&k,".",3,audible); REQUIRE(expectText(&q,"e"));
    keyFrames(&k,4*u,audible); sendLetter(&k,".",3,audible); REQUIRE(expectText(&q," e"));
    selectTypingDestination(&q,42); keyFrames(&k,u,audible);
    setPaddles(&k,1); keyFrames(&k,5*u,audible); setPaddles(&k,0);
    keyFrames(&k,3*u,audible); REQUIRE(expectText(&q,"s"));
    setPaddles(&k,3); keyFrames(&k,7*u,audible); setPaddles(&k,0);
    keyFrames(&k,3*u,audible); REQUIRE(expectText(&q,"r"));
    const char *paris[]={".--.",".-",".-.","..","..."};
    for (unsigned i=0; i<5; ++i) sendLetter(&k,paris[i],i==4 ? 7 : 3,audible);
    const char *numbers[]={"....-","----.","-..-.",".----","..--.."};
    for (unsigned i=0; i<5; ++i) sendLetter(&k,numbers[i],3,audible);
    REQUIRE(expectText(&q,"paris 49/1?"));
    sendLetter(&k,"............",3,audible); sendLetter(&k,".-.-.-",3,audible);
    REQUIRE(expectText(&q,"."));
    tap(&k,1,u,audible); selectTypingDestination(&q,77); keyFrames(&k,8*u,audible);
    REQUIRE(expectText(&q,""));
    sendLetter(&k,"-",3,audible); selectTypingDestination(&q,78); selectTypingDestination(&q,77);
    REQUIRE(expectText(&q,"")); keyFrames(&k,u,audible);
    sendLetter(&k,".",3,audible); resetTypingSession(&q); REQUIRE(expectText(&q,""));
    // Re-arm while in the middle of a held contact, then start a fresh word after release.
    selectTypingDestination(&q,0); setPaddles(&k,1); keyFrames(&k,2*u,audible);
    selectTypingDestination(&q,77); keyFrames(&k,4*u,audible); setPaddles(&k,0);
    keyFrames(&k,8*u,audible); sendLetter(&k,"-...",3,audible); REQUIRE(expectText(&q,"b"));
    return true;
}
static bool checkVolume(double rate) {
    Keyer reference={0}, adjustable={0}; configureKeyer(&reference,rate,30); configureKeyer(&adjustable,rate,30);
    SidetoneLevel volume={.percent=100,.muted=false}; adjustable.volume=&volume;
    setPaddles(&reference,2); setPaddles(&adjustable,2);
    float full[1024], scaled[1024], right[1024];
    const struct { unsigned percent; bool muted; } levels[]={
        {100,false},{50,false},{50,true},{80,true},{80,false},{0,false},{0,true},{0,false},{100,false}
    };
    for (unsigned pass=0; pass<sizeof(levels)/sizeof(levels[0]); ++pass) {
        unsigned percent=levels[pass].percent;
        float before=adjustable.volumeGain, target=levels[pass].muted ? 0 : percent*percent/10000.0f;
        atomic_store(&volume.percent,percent); atomic_store(&volume.muted,levels[pass].muted);
        REQUIRE(fabs(levelGain(&volume)-target)<.000001);
        UInt32 n=MIN(1024u,(UInt32)lround(rate*.012)), bytes=n*sizeof(float);
        AudioBufferList first={1,{{1,bytes,full}}};
        struct { UInt32 count; AudioBuffer buffers[2]; } stereo={2,{{1,bytes,scaled},{1,bytes,right}}};
        AudioUnitRenderActionFlags flags=0;
        REQUIRE(speakerRender(&reference,NULL,NULL,0,n,&first)==noErr);
        REQUIRE(speakerRender(&adjustable,&flags,NULL,0,n,(AudioBufferList *)&stereo)==noErr);
        REQUIRE(memcmp(scaled,right,bytes)==0);
        REQUIRE(((flags&kAudioUnitRenderAction_OutputIsSilence)!=0)==(before==0 && target==0));
        double peak=0;
        for (UInt32 i=0; i<n; ++i) {
            double fraction=MIN(1.0,(double)(i+1)/adjustable.volumeRamp);
            double expected=full[i]*(before+(target-before)*fraction);
            REQUIRE(fabs(scaled[i]-expected)<.00001); peak=fmax(peak,fabs(full[i]));
        }
        REQUIRE(peak>.19);
    }
    return true;
}
// Drive the actual detector with stereo pilots mixed through synthetic switch contacts.
static bool checkAdapterToText(double rate, bool swapped, bool audible) {
    TypingQueue q={0}; initTypingQueue(&q); selectTypingDestination(&q,50);
    Keyer k={0}; configureKeyer(&k,rate,30); k.typing=&q;
    SidetoneLevel volume={.percent=swapped ? 73u : 0u,.muted=swapped};
    k.volume=&volume; k.volumeGain=levelGain(&volume);
    atomic_bool reverse; atomic_init(&reverse,swapped);
    Detector d={.keyer=audible?&k:NULL,.swapRequested=&reverse}; Generator g={0}; unsigned noise=77;
    int mask[]={0,1,0,2,0,1,0};
    int blocks[]={SettleBlocks+IdleBlocks+10,18,20,36,24,18,48};
    for (unsigned i=0; i<sizeof(mask)/sizeof(mask[0]); ++i) for (int b=0; b<blocks[i]; ++b) {
        int physical=swapped && mask[i] ? 3-mask[i] : mask[i];
        synth(&d,&g,rate,physical,1,&noise,audible ? NULL : &k);
        if (audible) keyFrames(&k,inputFrames,true);
    }
    return expectText(&q,"sos");
}

static bool checkTextEvents(void) {
    const char *characters="abcdefghijklmnopqrstuvwxyz0123456789 .,-/=+@!:;\"'()_&?";
    for (const char *c=characters; *c; ++c) {
        CGEventRef down,up; REQUIRE(makeTypingKeys(*c,&down,&up));
        REQUIRE(CGEventGetType(down)==kCGEventKeyDown && CGEventGetType(up)==kCGEventKeyUp);
        REQUIRE(!CGEventGetFlags(down) && !CGEventGetFlags(up));
        CGEventRef events[]={down,up};
        for (unsigned i=0; i<2; ++i) {
            UniChar value=0; UniCharCount count=0;
            CGEventKeyboardGetUnicodeString(events[i],1,&count,&value);
            REQUIRE(count==1 && value==(unsigned char)*c);
        }
        CFRelease(down); CFRelease(up);
    }
    CGEventRef down,up; REQUIRE(!makeTypingKeys('\n',&down,&up) && !down && !up);
    return true;
}
