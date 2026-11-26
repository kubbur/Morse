// Exercise the production Windows DSP with its own stereo pilot generator fed
// back through a model of the four passive contact states.
#include "../Windows/Converter.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

enum { Rate=48000, Block=128 };
static ConverterSettings settings={20,12,650,75,2,3,0,false,false,false};
static void check(bool valid,const char *message) {
    if (!valid) { fprintf(stderr,"FAILED: %s\n",message); exit(1); }
}
static void input(Converter *core,unsigned mask,float *speaker,unsigned frames) {
    float pilots[Block*2],mic[Block];
    converterPilots(core,pilots,frames);
    for (unsigned i=0;i<frames;i++) {
        mic[i]=pilots[2*i]*(.0004f+((mask&1) ? .029f : 0.f))
            +pilots[2*i+1]*(.0003f+((mask&2) ? .012f : 0.f));
    }
    converterInput(core,mic,frames); converterSpeaker(core,speaker,frames);
}
static void run(Converter *core,unsigned mask,unsigned frames) {
    float speaker[Block];
    while (frames) { unsigned n=frames<Block ? frames : Block; input(core,mask,speaker,n); frames-=n; }
}
static void scenario(unsigned mask,bool reversed,bool mute) {
    settings.reverse=reversed; Converter *core=converterCreate(7,&settings,NULL);
    check(core!=NULL,"create");
    converterMute(core,mute);
    unsigned seen=0,starts=0,stops=0,samples=0; uint64_t start=0;
    bool down=false; unsigned logical=reversed ? ((mask&1)<<1)|((mask&2)>>1) : mask;
    for (unsigned f=0;f<3*Rate;f+=Block) {
        float pcm[Block]; bool marked[Block];
        unsigned physical=f>=2*Rate && f<2*Rate+Rate/3 ? mask : 0;
        input(core,physical,pcm,Block);
        ConverterState state=converterState(core);
        if (state.ready) seen|=1u<<state.mask;
        for (unsigned i=0;i<Block;i++) marked[i]=down;
        ConverterEdge e;
        while (converterEdge(core,&e)) {
            check(e.epoch==7 && e.rate==Rate,"event clock");
            if (!e.kind) continue;
            check(e.frame>=f && e.frame<=f+Block,"event outside rendered block");
            if (e.kind==1) { check(!down,"double down"); down=true; start=e.frame; starts++; }
            else {
                check(down,"key up without down"); down=false;
                unsigned element=logical==3 ? (stops%2 ? 2 : 1) : logical;
                check(e.frame-start==(element==1 ? 2880u : 8640u),"dot/dash duration or squeeze order");
                stops++;
            }
            for (unsigned i=(unsigned)(e.frame-f);i<Block;i++) marked[i]=down;
        }
        for (unsigned i=0;i<Block;i++) if (fabsf(pcm[i])>.00001f) {
            check(marked[i] && !mute,"sidetone outside a scored mark"); samples++;
        }
    }
    check(seen==((1u<<logical)|1u),"contact state or false opposite contact");
    check(converterState(core).mask==0 && !down && starts==stops && (mask ? starts>=2 : starts==0),"release or stuck mark");
    check((samples>0)==(mask!=0 && !mute),"sidetone mute or missing audio");
    converterDestroy(core);
}
int main(void) {
    for (unsigned mask=0;mask<4;mask++) {
        scenario(mask,false,false); scenario(mask,true,false); scenario(mask,false,true);
    }
    settings.reverse=false;
    Converter *c=converterCreate(1,&settings,NULL); check(c!=NULL,"create for calibration");
    converterCalibrate(c);
    for (unsigned mask=0;mask<4;mask++) {
        check(converterState(c).calibration==(int)(InputReleased+mask),"calibration position");
        converterSample(c,true); run(c,mask,2*Rate);
    }
    ConverterProfile profile=converterProfile(c);
    check(converterState(c).calibration==InputCalibrated && profile.boosted && profile.on[0]>profile.off[0] &&
        profile.on[1]>profile.off[1],"four-position boosted calibration");
    converterDestroy(c);
    c=converterCreate(2,&settings,&profile); run(c,0,2*Rate); run(c,3,Rate/4);
    check(converterState(c).mask==3,"restored converter calibration");
    converterInterrupt(c); run(c,3,Rate/4);
    check(!converterState(c).ready && !converterState(c).mask && converterState(c).epoch==3,"hold across interruption");
    run(c,0,Rate/4); check(converterState(c).ready,"neutral rearms detector");
    converterEndCalibration(c,true); check(!converterProfile(c).boosted && converterProfile(c).on[0]==0,"automatic levels");
    converterDestroy(c);
    puts("PASS Windows converter: released, left, right, squeeze, reverse, mute, sample-accurate scoring and sidetone, calibration, restore and reconnect neutral gate.");
    return 0;
}
