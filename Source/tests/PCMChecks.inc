// Model the two switch contacts and resistor losses using the real generator.
static void synth(Detector *d, Generator *g, double hz, int mask, int blocks, unsigned *rng, Keyer *quiet) {
    float samples[MaxBlock], stereo[MaxBlock*2];
    for (int b=0; b<blocks; ++b) {
        tones(g,stereo,inputFrames,hz);
        for (UInt32 i=0; i<inputFrames; ++i) {
            *rng = *rng * 1664525u + 1013904223u;
            double noise = ((double)(*rng >> 8)/16777216.0-.5)*.0006;
            samples[i] = stereo[2*i]*(.0004 + ((mask&1) ? .029 : 0)) +
                         stereo[2*i+1]*(.0003 + ((mask&2) ? .012 : 0)) + noise;
        }
        acceptInput(d,quiet,samples,inputFrames);
    }
}
// Inspect the same stereo PCM callback that feeds the speakers. Buffer boundaries
// deliberately fall inside marks and spaces, just as they do during live audio.
static bool expectSpeakerPCM(Keyer *k, double rate, UInt32 frames, bool mark) {
    float left[193], right[193];
    UInt32 edge=(UInt32)ceil(rate*.002);
    for (UInt32 offset=0; offset<frames;) {
        UInt32 n=MIN(193u,frames-offset);
        UInt32 bytes=n*sizeof(float);
        struct { UInt32 count; AudioBuffer buffers[2]; } audio={2,{{1,bytes,left},{1,bytes,right}}};
        AudioUnitRenderActionFlags flags=0;
        if (speakerRender(k,&flags,NULL,0,n,(AudioBufferList *)&audio)!=noErr ||
            memcmp(left,right,bytes)) return false;
        for (UInt32 i=0; i<n; ++i) {
            UInt32 t=offset+i;
            if (!isfinite(left[i]) || fabs(left[i])>.201) return false;
            if (!mark && left[i]!=0) return false;
            if (mark && (!t || t==frames-1) && fabs(left[i])>1e-6) return false;
            if (mark && t>=edge && t<frames-edge) {
                const double reference=.2*sin(2*M_PI*650*t/rate);
                if (fabs(left[i]-reference)>.00001) return false;
            }
        }
        offset+=n;
    }
    return true;
}
static bool checkKeyer(double rate) {
    Keyer k={0}; configureKeyer(&k,rate,30);
    UInt32 dot=(UInt32)lround(rate*.040), dash=3*dot;
    if (!expectSpeakerPCM(&k,rate,dot,false)) return false;
    setPaddles(&k,1);
    if (!expectSpeakerPCM(&k,rate,dot,true) || k.gapLeft!=dot ||
        !expectSpeakerPCM(&k,rate,dot,false) || !expectSpeakerPCM(&k,rate,dot,true)) return false;
    setPaddles(&k,0);
    if (!expectSpeakerPCM(&k,rate,dot+11,false)) return false;
    setPaddles(&k,2); setPaddles(&k,0); // Entire tap between two speaker callbacks.
    if (!expectSpeakerPCM(&k,rate,dash,true) || k.gapLeft!=dot || !expectSpeakerPCM(&k,rate,dot+11,false)) return false;
    setPaddles(&k,3);
    if (!expectSpeakerPCM(&k,rate,dot,true) || !expectSpeakerPCM(&k,rate,dot,false) ||
        !expectSpeakerPCM(&k,rate,dash,true) || !expectSpeakerPCM(&k,rate,dot,false) ||
        !expectSpeakerPCM(&k,rate,dot,true)) return false;
    setPaddles(&k,0);
    return expectSpeakerPCM(&k,rate,2*dot,false);
}
