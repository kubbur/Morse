// Time the same waveform and the same speaker callback on both detector paths.
// The old path receives disjoint 10 ms buffers as in 1.1.0-dev.2. The new
// path receives the slices allocated by prepareQueue.
static void deliverJackSlice(Detector *d, const float *window, unsigned frame) {
    if (!frame) return;
    unsigned end=(frame-1)%inputFrames+1, i=d->sliceIndex;
    if (end==sliceEnd[i]) acceptInput(d,NULL,window+end-slicePlan[i].count,slicePlan[i].count);
}
typedef struct {
    double min, median, p95, max;
} DelaySummary;

static DelaySummary summarizeDelays(double *delays, unsigned count) {
    qsort(delays,count,sizeof(*delays),ascending);
    return (DelaySummary){delays[0],delays[(count-1)/2],delays[(count*95+99)/100-1],delays[count-1]};
}

typedef enum { BenchUSB, BenchOriginalJack, BenchJack } BenchInput;
static bool measureOnset(BenchInput route, unsigned side, unsigned rate, unsigned renderFrames,
                         bool calibrated, DelaySummary *summary) {
    NSUserDefaults *defaults=[[IsolatedDefaults alloc] initWithSuiteName:NSUUID.UUID.UUIDString];
    [defaults setVolatileDomain:@{} forName:NSArgumentDomain];
    MorseEngine *usb=[[MorseEngine alloc] initWithDefaults:defaults];
    usb.inputMode=PaddleInputVBand;
    double delays[MaxBlock];
    for (unsigned offset=0;offset<inputFrames;offset++) {
        Keyer key={0}; ElementStream stream={0};
        configureKeyer(&key,rate,30); key.stream=&stream;
        if (route==BenchUSB) { [usb setVBandContacts:0]; key.contacts=usb.vbandContactQueue; }
        Detector d={.keyer=&key,.calibrated=SettleBlocks+IdleBlocks};
        setIdleLevel(&d,0,.001); setIdleLevel(&d,1,.001);
        if (calibrated) d.profile=(InputProfile){.on={.01695,.01695},.off={.0097,.0097}};
        float input[MaxBlock], out[512];
        REQUIRE(renderFrames<=512);
        AudioBufferList audio={1,{{1,renderFrames*sizeof(float),out}}};
        unsigned contact=4*inputFrames+offset, first=0;
        for (unsigned t=0;t<contact+rate/10;t++) {
            unsigned pos=t%inputFrames;
            if (route==BenchJack) deliverJackSlice(&d,input,t);
            else if (route==BenchOriginalJack && t && !pos) detectWindow(&d,input,d.stable);
            if (route!=BenchUSB) {
                double dit=t>=contact && side==1 ? .03 : .001;
                double dah=t>=contact && side==2 ? .03 : .001;
                input[pos]=(float)(dit*sin(2*M_PI*1000*t/rate)+dah*sin(2*M_PI*1600*t/rate));
            } else if (t==contact) [usb setVBandContacts:side];
            if (t%renderFrames) continue;
            REQUIRE(speakerRender(&key,NULL,NULL,0,renderFrames,&audio)==noErr);
            for (unsigned i=0;i<renderFrames;i++) if (fabs(out[i])>.0001f) { first=t+i; break; }
            if (first) break;
        }
        REQUIRE(first>=contact);
        delays[offset]=(first-contact)*1000./rate;
    }
    *summary=summarizeDelays(delays,inputFrames);
    return true;
}

static int inputLatency(void) {
    // 44.1 kHz has two different slice sizes. Vary render size
    // independently of input capture and include installed calibration levels.
    for (unsigned config=0;config<3;config++) {
        unsigned rate=config==1 ? 44100 : 48000;
        unsigned renderFrames=(unsigned[]){128,256,512}[config];
        makeTables(rate);
        if (!config) {
            DelaySummary usb;
            if (!measureOnset(BenchUSB,1,rate,renderFrames,false,&usb) || usb.max>3) return 3;
            printf("VBand at %u Hz, %u-frame render: %.2f to %.2f ms\n",rate,renderFrames,usb.min,usb.max);
        }
        for (unsigned side=1;side<=2;side++) {
            DelaySummary old, current;
            if (!measureOnset(BenchOriginalJack,side,rate,renderFrames,config!=0,&old) ||
                !measureOnset(BenchJack,side,rate,renderFrames,config!=0,&current)) return 3;
            printf("Audio converter at %u Hz, %u-frame render, %s, %s: "
                   "original %.2f–%.2f ms (median %.2f, p95 %.2f); "
                   "candidate %.2f–%.2f ms (median %.2f, p95 %.2f)\n",
                   rate,renderFrames,side==1?"dit":"dah",config?"saved calibration":"automatic levels",
                   old.min,old.max,old.median,old.p95,current.min,current.max,current.median,current.p95);
            if (current.median+8>=old.median || current.p95+8>=old.p95 ||
                current.max>10.5+renderFrames*1000.0/rate) return 3;
        }
    }
    return 0;
}

// CPU time for equivalent captured audio. Excludes the driver, run-loop
// dispatch and the speaker. The two waveforms are generated before timing.
static void detectorCost(void) {
    const unsigned rate=48000, windows=6000;
    float pcm[2][480];
    makeTables(rate);
    for (unsigned i=0;i<inputFrames;i++) {
        double t=(double)i/rate;
        pcm[0][i]=(float)(.001*cos(2*M_PI*1000*t)+.001*sin(2*M_PI*1600*t));
        pcm[1][i]=(float)(.04*cos(2*M_PI*1000*t)+.03*sin(2*M_PI*1600*t));
    }
    for (unsigned fast=0;fast<=1;fast++) {
        Detector d={.calibrated=SettleBlocks+IdleBlocks};
        setIdleLevel(&d,0,.001); setIdleLevel(&d,1,.001);
        uint64_t begin=clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID);
        for (unsigned i=0;i<windows;i++) {
            const float *input=pcm[(i/10)%2];
            if (fast) {
                for (unsigned slice=0;slice<SlicesPerWindow;slice++) {
                    UInt32 n=slicePlan[slice].count;
                    acceptInput(&d,NULL,input+sliceEnd[slice]-n,n);
                }
            } else detectWindow(&d,input,d.stable);
        }
        uint64_t elapsed=clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)-begin;
        printf("%s detector: %.2f microseconds of thread CPU per 10 ms of input at %u Hz (final mask %d)\n",
               fast?"Candidate":"Original",elapsed/(1000.*windows),rate,d.stable);
    }
}

typedef struct { unsigned masks[16], count, last; } JackTransitions;
static void recordJackTransition(void *context, unsigned mask, bool swapped) {
    (void)swapped;
    JackTransitions *e=context;
    if (mask==e->last) return;
    if (e->count<16) e->masks[e->count]=mask;
    ++e->count; e->last=mask;
}
static void setupJackFixture(Detector *d, JackTransitions *events) {
    d->calibrated=SettleBlocks+IdleBlocks;
    d->context=events; d->change=recordJackTransition;
    setIdleLevel(d,0,.001); setIdleLevel(d,1,.001);
}

static bool checkInterference(double rate) {
    float pcm[MaxBlock];
    // Short pilot bursts, sharp single-sample impulses, off-frequency tones
    // and deterministic broad-band bursts are deliberately outside the model.
    for (unsigned fault=0;fault<7;fault++) for (unsigned offset=0;offset<inputFrames;offset+=MAX(1u,inputFrames/12)) {
        JackTransitions events={0}; Detector d={0}; setupJackFixture(&d,&events);
        uint32_t seed=4097;
        unsigned start=3*inputFrames+offset;
        for (unsigned block=0;block<13;block++) {
            for (unsigned i=0;i<inputFrames;i++) {
                unsigned sample=block*inputFrames+i;
                double t=sample/rate, x=.001*sin(2*M_PI*1000*t)+.001*cos(2*M_PI*1600*t);
                if (sample>=start && sample<start+6*inputFrames) {
                    unsigned elapsed=sample-start;
                    seed=1664525u*seed+1013904223u;
                    if (fault==0 && elapsed==0) x+=.9;
                    if (fault==1 && elapsed<.004*rate) x+=.12*cos(2*M_PI*1600*t);
                    if (fault==2 && elapsed<.005*rate) x+=.12*sin(2*M_PI*1000*t);
                    if (fault==3) x+=.08*sin(2*M_PI*1040*t)+.06*cos(2*M_PI*1560*t);
                    if (fault==6) x+=.08*sin(2*M_PI*1018*t)+.06*cos(2*M_PI*1582*t);
                    if (fault==4) x+=.10*sin(2*M_PI*1200*t)+.07*cos(2*M_PI*1400*t);
                    if (fault==5) x+=.15*((double)(seed>>8)/16777216.0-.5);
                }
                pcm[i]=(float)x;
            }
            acceptInput(&d,NULL,pcm,inputFrames);
        }
        if (events.count) fprintf(stderr,"Interference %u at %.0f Hz, offset %u emitted %u events\n",fault,rate,offset,events.count);
        REQUIRE(!events.count);
    }
    return true;
}

static bool checkJackEvidence(double rate) {
    // Huge level differences exercise isolation between fits at odd rates.
    // Deliver a complete signal in uneven fragments, including single samples.
    float pcm[MaxBlock];
    JackTransitions events={0}, reference={0};
    Detector d={0}, legacy={0}; setupJackFixture(&d,&events); setupJackFixture(&legacy,&reference);
    d.profile=legacy.profile=(InputProfile){.on={.025,.0008},.off={.015,.0004}};
    unsigned firstNew=0,firstOld=0;
    for (unsigned block=0;block<20;block++) {
        for (unsigned i=0;i<inputFrames;i++) {
            double t=(block*inputFrames+i)/rate;
            double dit=block>=3 && block<12 ? .029 : .001;
            double dah=block>=9 && block<15 ? .005 : .0001;
            pcm[i]=(float)(dit*sin(2*M_PI*1000*t+.42)+dah*cos(2*M_PI*1600*t+.73));
        }
        detectWindow(&legacy,pcm,legacy.stable);
        for (unsigned pos=0;pos<inputFrames;) {
            unsigned n=MIN(inputFrames-pos,1+(pos*11u+block)%73u);
            acceptInput(&d,NULL,pcm+pos,n); pos+=n;
            if (!firstNew && (d.stable&1)) firstNew=block*inputFrames+pos;
        }
        if (!firstOld && (legacy.stable&1)) firstOld=(block+1)*inputFrames;
    }
    // Dit is above threshold but below fast-path headroom. The saved
    // calibration must still accept it at the same boundary as the old path.
    REQUIRE(firstOld && firstNew==firstOld);
    unsigned expected[]={1,3,2,0};
    REQUIRE(events.count==4 && !memcmp(events.masks,expected,sizeof(expected)));
    REQUIRE(reference.count==4 && !memcmp(reference.masks,expected,sizeof(expected)));
    return true;
}

// Drive the native speaker and typed-text decoder from the same synthetic jack
// return. Squeeze release should produce A in mode A and R in mode B.
static bool checkJackKeying(double rate, double speakerRate, unsigned wpm, bool modeB) {
    for (unsigned offset=0;offset<inputFrames;offset+=MAX(1u,inputFrames/32)) {
        TypingQueue typing={0}; initTypingQueue(&typing); selectTypingDestination(&typing,42);
        Keyer key={0}; configureKeyer(&key,speakerRate,wpm); key.typing=&typing;
        key.initialSettings.options=TrainerGapThresholds|(modeB ? IambicModeB : 0);
        ElementStream stream={0}; key.stream=&stream;
        JackTransitions events={0}; Detector d={.keyer=&key}; setupJackFixture(&d,&events);
        unsigned unit=(unsigned)lround(speakerRate*1.2/wpm), start=4*inputFrames+offset;
        unsigned finish=start+(unsigned)ceil(16*rate*1.2/wpm);
        double nextRender=(offset*37%128)*rate/speakerRate;
        float input[MaxBlock], output[128]; AudioBufferList audio={1,{{1,sizeof(output),output}}};
        unsigned marks=0, press=0, audible=0, changedAt[16]={0};
        for (unsigned t=0;t<finish;t++) {
            unsigned previous=events.count;
            unsigned pos=t%inputFrames;
            deliverJackSlice(&d,input,t);
            if (events.count!=previous && previous<16) changedAt[previous]=t;
            // At 30 WPM release a squeeze during the dash. At the WPM limits,
            // two distinct 20 ms taps must produce a dit and a remembered dah.
            bool dit=t>=start && t<start+(wpm==30 ? 9*inputFrames : 2*inputFrames);
            unsigned dahStart=start+(wpm==30 ? inputFrames : 3*inputFrames);
            bool dah=t>=dahStart && t<(wpm==30 ? start+9*inputFrames : dahStart+2*inputFrames);
            double phase=2*M_PI*t/rate;
            input[pos]=(float)((dit?.045:.001)*sin(1000*phase+.25)+(dah?.03:.001)*cos(1600*phase+.42));
            if (t<nextRender) continue;
            nextRender+=128*rate/speakerRate;
            REQUIRE(speakerRender(&key,NULL,NULL,0,128,&audio)==noErr);
            for (unsigned i=0;i<128;i++) if (fabs(output[i])>.0001f) ++audible;
            ElementEvent edge;
            while (takeElement(&stream,&edge)) {
                if (edge.kind==1) press=(unsigned)edge.frame;
                if (edge.kind==2) {
                    unsigned frames=(unsigned)edge.frame-press, expected=marks==1 ? 3*unit : unit;
                    REQUIRE(frames==expected); ++marks;
                }
            }
        }
        bool extra=(wpm==30 && modeB);
        if (marks!=(extra ? 3u : 2u) || audible<=(extra ? 4.5 : 3.5)*unit) {
            fprintf(stderr,"Jack/speaker %.0f/%.0f Hz, %u WPM, mode %c, offset %u: %u marks, %u nonzero frames, contacts",
                    rate,speakerRate,wpm,modeB?'B':'A',offset,marks,audible);
            for (unsigned i=0;i<MIN(events.count,16u);i++) fprintf(stderr," %u@%.2f",events.masks[i],(changedAt[i]-(double)start)*1000/rate);
            fputc('\n',stderr); return false;
        }
        REQUIRE(expectText(&typing,extra ? "r" : "a"));
        REQUIRE(!d.stable);
    }
    return true;
}

static bool checkJackRelease(double rate) {
    for (unsigned offset=0;offset<inputFrames;offset+=MAX(1u,inputFrames/16)) {
        Detector d={0}; JackTransitions events={0}; setupJackFixture(&d,&events);
        unsigned start=4*inputFrames+offset, gap=start+4*inputFrames, release=start+9*inputFrames;
        unsigned first=0, last=0;
        float pcm[MaxBlock];
        for (unsigned t=0;t<release+4*inputFrames;t++) {
            unsigned pos=t%inputFrames;
            deliverJackSlice(&d,pcm,t);
            if (d.stable && !first) first=t;
            if (first && !d.stable && !last) last=t;
            bool held=t>=start && t<release && !(t>=gap && t<gap+.003*rate);
            pcm[pos]=(float)((held?.04:.001)*sin(2*M_PI*1000*t/rate+.23)+.001*cos(2*M_PI*1600*t/rate));
        }
        REQUIRE(events.count==2 && first>=start && first-start<=.016*rate);
        REQUIRE(last>=release && last-release<=.016*rate);
    }
    return true;
}

static bool checkJackInterruption(double rate) {
    Session s={0}; JackTransitions events={0}; ElementStream stream={0};
    setupJackFixture(&s.detector,&events);
    configureKeyer(&s.quietKeyer,rate,30); s.quietKeyer.stream=&stream;
    float held[MaxBlock], neutral[MaxBlock]={0};
    for (unsigned i=0;i<inputFrames;i++) held[i]=(float)(.12*sin(2*M_PI*1000*i/rate));
    AudioTimeStamp stamp={.mFlags=kAudioTimeStampSampleTimeValid};
    receiveInput(&s,held,slicePlan[0].count+1,&stamp);
    REQUIRE(s.detector.havePreviousSlice && !events.count);
    stamp.mSampleTime=inputFrames*10; // Missing microphone frames, with the contact held.
    receiveInput(&s,held,inputFrames,&stamp);
    REQUIRE(atomic_load(&stream.epoch)==1 && s.detector.waitForRelease && !s.detector.havePreviousSlice && !events.count);
    for (int i=0;i<4;i++) { stamp.mSampleTime+=inputFrames; receiveInput(&s,neutral,inputFrames,&stamp); }
    REQUIRE(!s.detector.waitForRelease && !events.count);
    stamp.mSampleTime+=inputFrames; receiveInput(&s,held,inputFrames,&stamp);
    REQUIRE(events.count==1 && s.detector.stable==1);
    beginCapture(&s.detector); samplePosition(&s.detector,false);
    stamp.mSampleTime+=2*inputFrames; receiveInput(&s,held,inputFrames,&stamp);
    REQUIRE(s.detector.step==InputReleased && !s.detector.sampling && !s.detector.stable);
    unsigned epoch=atomic_load(&stream.epoch);
    stamp.mSampleTime=NAN; receiveInput(&s,held,inputFrames,&stamp);
    REQUIRE(atomic_load(&stream.epoch)==epoch+1 && !s.haveInputTime);
    receiveInput(&s,held,inputFrames,NULL);
    REQUIRE(atomic_load(&stream.epoch)==epoch+1);
    stamp.mSampleTime=100; receiveInput(&s,held,inputFrames,&stamp);
    REQUIRE(atomic_load(&stream.epoch)==epoch+2 && s.haveInputTime && !s.detector.stable);
    return true;
}
