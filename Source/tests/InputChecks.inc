// Synthesize pilot PCM at the dBFS levels observed by the original 48 kHz tester.
// The log records level snapshots, not a continuous audio recording.
static void measuredInput(Detector *d, double rate, uint64_t *sample, int frames,
                          double ditDB, double dahDB, double offsetHz) {
    float pcm[MaxBlock];
    double dit=pow(10,ditDB/20), dah=pow(10,dahDB/20);
    for (int b=0;b<frames;++b) {
        for (UInt32 i=0;i<inputFrames;++i,++*sample) {
            double t=*sample/rate;
            pcm[i]=(float)(dit*sin(2*M_PI*(1000+offsetHz)*t+.21)+dah*sin(2*M_PI*(1600-offsetHz)*t-.32));
        }
        acceptInput(d,NULL,pcm,inputFrames);
    }
}
static void recordMask(void *context, unsigned mask, bool swapped) {
    (void)swapped;
    unsigned *edges=context; ++edges[mask];
}
static void measurePosition(Detector *d, double rate, uint64_t *sample, double ditDB, double dahDB) {
    samplePosition(d,true);
    measuredInput(d,rate,sample,CaptureSettle+CaptureBlocks,ditDB,dahDB,0);
}
static bool checkMovementInput(double rate) {
    unsigned events[4]={0};
    Detector d={.change=recordMask,.context=events};
    uint64_t sample=0;
    measuredInput(&d,rate,&sample,SettleBlocks+IdleBlocks+2,-44,-40,0);
    beginCapture(&d); REQUIRE(d.step==InputReleased);
    samplePosition(&d,true);
    measuredInput(&d,rate,&sample,CaptureSettle+CaptureBlocks/2,-44,-40,0);
    measuredInput(&d,rate,&sample,CaptureBlocks/2,-29,-29,0);
    REQUIRE(d.step==InputFirst && !d.sampling);
    measurePosition(&d,rate,&sample,-43,-14); REQUIRE(d.step==InputOther);
    measurePosition(&d,rate,&sample,-14,-39); REQUIRE(d.step==InputBoth);
    measurePosition(&d,rate,&sample,-14,-14);
    REQUIRE(!d.step && d.waitForRelease && d.profile.boosted);
    REQUIRE(d.profile.on[0]>pow(10,-24.0/20) && d.profile.off[0]<d.profile.on[0]);
    measuredInput(&d,rate,&sample,6,-14,-14,0);
    REQUIRE(d.waitForRelease && !events[1] && !events[2] && !events[3]);
    measuredInput(&d,rate,&sample,2,-44,-40,0); REQUIRE(!d.waitForRelease);
    measuredInput(&d,rate,&sample,100,-29,-29,0); REQUIRE(!events[3]);
    // A sustained vibration near each pilot must not masquerade as two returns.
    measuredInput(&d,rate,&sample,12,-14,-14,40); REQUIRE(!d.stable && !events[3]);
    measuredInput(&d,rate,&sample,3,-44,-40,0);
    measuredInput(&d,rate,&sample,4,-14,-39,0); REQUIRE(d.stable==1 && events[1]==1);
    measuredInput(&d,rate,&sample,2,-29,-29,0); REQUIRE(d.stable==0);
    // Held squeeze, release just one paddle, then both. Each edge is independent.
    measuredInput(&d,rate,&sample,250,-14,-14,0); REQUIRE(d.stable==3 && events[3]==1);
    measuredInput(&d,rate,&sample,2,-43,-14,0); REQUIRE(d.stable==2);
    measuredInput(&d,rate,&sample,2,-43,-40,0); REQUIRE(d.stable==0);
    InputProfile saved=d.profile;
    // At the quieter setting a -46/-46 squeeze overlaps -46/-46 movement.
    // Keep the known good profile when the two cannot be distinguished.
    beginCapture(&d);
    measurePosition(&d,rate,&sample,-46,-46);
    measurePosition(&d,rate,&sample,-32,-56);
    measurePosition(&d,rate,&sample,-62,-31);
    measurePosition(&d,rate,&sample,-46,-46);
    REQUIRE(d.profile.on[0]==saved.on[0] && d.profile.off[1]==saved.off[1] && d.waitForRelease);
    // A weaker real squeeze is valid when it is distinct from movement.
    beginCapture(&d);
    measurePosition(&d,rate,&sample,-59,-57); measurePosition(&d,rate,&sample,-32,-56);
    measurePosition(&d,rate,&sample,-62,-31); measurePosition(&d,rate,&sample,-46,-46);
    REQUIRE(d.profile.on[0]<pow(10,-46.0/20) && d.profile.on[0]!=saved.on[0]);
    measuredInput(&d,rate,&sample,2,-64,-59,0);
    measuredInput(&d,rate,&sample,4,-46,-46,0); REQUIRE(d.stable==3);
    measuredInput(&d,rate,&sample,2,-64,-59,0); REQUIRE(!d.stable);
    return true;
}
static bool checkInputRecovery(double rate) {
    Detector d={0}; uint64_t sample=0;
    measuredInput(&d,rate,&sample,SettleBlocks+IdleBlocks,-45,-15,0);
    REQUIRE(20*log10(d.on[1])>-9);
    measuredInput(&d,rate,&sample,30,-45,-41,0);
    REQUIRE(20*log10(d.on[1]) < -30);
    measuredInput(&d,rate,&sample,4,-44,-15,0); REQUIRE(d.stable==2);
    measuredInput(&d,rate,&sample,2,-45,-41,0); REQUIRE(!d.stable);
    return true;
}
static bool checkWiredBoost(double rate) {
    Generator normal={0}, boosted={.boosted=true};
    Keyer speaker[2]={0}; SidetoneLevel level={.percent=37};
    for (int k=0;k<2;++k) { configureKeyer(&speaker[k],rate,30); speaker[k].volume=&level; setPaddles(&speaker[k],2); }
    float first[2*MaxBlock], second[2*MaxBlock];
    for (int i=0;i<4;++i) { tones(&normal,first,inputFrames,rate); tones(&boosted,second,inputFrames,rate); }
    for (UInt32 i=0;i<2*inputFrames;++i) REQUIRE(fabs(second[i]-2*first[i])<.000001);
    AudioBufferList outA={1,{{1,inputFrames*sizeof(float),first}}}, outB={1,{{1,inputFrames*sizeof(float),second}}};
    REQUIRE(speakerRender(&speaker[0],NULL,NULL,0,inputFrames,&outA)==noErr);
    REQUIRE(speakerRender(&speaker[1],NULL,NULL,0,inputFrames,&outB)==noErr);
    REQUIRE(!memcmp(first,second,inputFrames*sizeof(float)) && speaker[0].volumeGain>0 && first[inputFrames/3]!=0);
    boosted.boosted=false;
    for (int i=0;i<3;++i) { tones(&normal,first,inputFrames,rate); tones(&boosted,second,inputFrames,rate); }
    REQUIRE(!memcmp(first,second,2*inputFrames*sizeof(float)));
    return true;
}
