#import "TonePanel.h"
#import "MorseEngine.h"
#include <math.h>

@interface EnvelopePreview : NSView
@property ToneSettings tone;
@property BOOL dah;
@end
@implementation EnvelopePreview
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSRect bounds=self.bounds;
    [[NSColor colorWithSRGBRed:.064 green:.102 blue:.096 alpha:1] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:bounds xRadius:9 yRadius:9] fill];
    NSRect plot=NSMakeRect(16,25,NSWidth(bounds)-32,NSHeight(bounds)-39);
    NSBezierPath *grid=[NSBezierPath bezierPath];
    for (int i=0;i<=4;i++) {
        CGFloat x=NSMinX(plot)+NSWidth(plot)*i/4;
        [grid moveToPoint:NSMakePoint(x,NSMinY(plot))]; [grid lineToPoint:NSMakePoint(x,NSMaxY(plot))];
    }
    for (int i=0;i<=2;i++) {
        CGFloat y=NSMinY(plot)+NSHeight(plot)*i/2;
        [grid moveToPoint:NSMakePoint(NSMinX(plot),y)]; [grid lineToPoint:NSMakePoint(NSMaxX(plot),y)];
    }
    [[NSColor colorWithWhite:.7 alpha:.18] setStroke]; [grid stroke];
    uint32_t frames=(uint32_t)lround(48000*1.2*(_dah?3:1)/_tone.wpm);
    ToneRamps ramps=fitToneRamps(_tone,48000,frames);
    NSBezierPath *line=[NSBezierPath bezierPath];
    NSUInteger pixels=(NSUInteger)ceil(NSWidth(plot));
    for (NSUInteger i=0;i<=pixels;i++) {
        double t=(double)i/pixels;
        double gain=toneEnvelopeGain(&ramps,(uint32_t)llround(t*ramps.last));
        NSPoint p=NSMakePoint(NSMinX(plot)+t*NSWidth(plot),NSMinY(plot)+gain*NSHeight(plot));
        if (i==0) [line moveToPoint:p]; else [line lineToPoint:p];
    }
    NSColor *lime=[NSColor colorWithSRGBRed:.81 green:.95 blue:.57 alpha:1];
    NSBezierPath *area=[line copy]; [area closePath]; [[lime colorWithAlphaComponent:.14] setFill]; [area fill];
    [lime setStroke]; line.lineWidth=2.2; [line stroke];
    NSDictionary *attrs=@{NSFontAttributeName:[NSFont systemFontOfSize:10 weight:NSFontWeightMedium],
                          NSForegroundColorAttributeName:[NSColor colorWithWhite:.8 alpha:1]};
    NSArray<NSString *> *captions=@[@"Rise",@"Hold",@"Fall"];
    for (NSUInteger i=0;i<captions.count;i++) {
        NSString *caption=captions[i]; CGFloat width=[caption sizeWithAttributes:attrs].width;
        CGFloat x=NSMinX(plot)+(NSWidth(plot)-width)*i/2;
        [caption drawAtPoint:NSMakePoint(x,6) withAttributes:attrs];
    }
}
@end

static NSTextField *panelLabel(NSView *parent, NSString *text, NSRect frame) {
    NSTextField *view=[NSTextField labelWithString:text]; view.frame=frame;
    [parent addSubview:view]; return view;
}
static NSSlider *rampSlider(NSView *parent, NSString *title, CGFloat y, id owner) {
    panelLabel(parent,title,NSMakeRect(20,y+2,109,20));
    NSSlider *slider=[NSSlider sliderWithValue:2 minValue:MinRampMs maxValue:MaxRampMs target:owner action:@selector(editRamp:)];
    slider.continuous=YES; slider.frame=NSMakeRect(131,y,245,23);
    [slider setAccessibilityLabel:title]; [parent addSubview:slider]; return slider;
}
@implementation TonePanel {
    MorseEngine *_engine;
    EnvelopePreview *_preview;
    NSSegmentedControl *_length, *_presets;
    NSSlider *_rise, *_fall;
    NSTextField *_duration, *_riseNumber, *_fallNumber;
    NSPopUpButton *_curves;
}
- (instancetype)initWithEngine:(MorseEngine *)engine {
    NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,462,365)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    if ((self=[super initWithWindow:window])) {
        _engine=engine; window.title=@"Tone envelope"; window.releasedWhenClosed=NO; [window center];
        NSView *v=window.contentView;
        _duration=panelLabel(v,@"",NSMakeRect(20,326,252,22));
        _length=[NSSegmentedControl segmentedControlWithLabels:@[@"Dit",@"Dah"] trackingMode:NSSegmentSwitchTrackingSelectOne
            target:self action:@selector(choosePreview:)];
        _length.frame=NSMakeRect(314,324,128,26); _length.selectedSegment=0;
        [_length setAccessibilityLabel:@"Preview element"]; [v addSubview:_length];
        _preview=[[EnvelopePreview alloc] initWithFrame:NSMakeRect(20,184,422,128)];
        [_preview setAccessibilityElement:YES]; [_preview setAccessibilityRole:NSAccessibilityImageRole]; [v addSubview:_preview];
        _presets=[NSSegmentedControl segmentedControlWithLabels:@[@"Crisp · 2 ms",@"Balanced · 5 ms",@"Soft · 10 ms"]
            trackingMode:NSSegmentSwitchTrackingSelectOne target:self action:@selector(choosePreset:)];
        _presets.frame=NSMakeRect(18,143,426,28); _presets.segmentDistribution=NSSegmentDistributionFillEqually;
        [_presets setAccessibilityLabel:@"Envelope preset"]; [v addSubview:_presets];
        _rise=rampSlider(v,@"Rise / attack",105,self); _fall=rampSlider(v,@"Fall / release",70,self);
        _riseNumber=panelLabel(v,@"",NSMakeRect(377,107,65,20)); _riseNumber.alignment=NSTextAlignmentRight;
        _fallNumber=panelLabel(v,@"",NSMakeRect(377,72,65,20)); _fallNumber.alignment=NSTextAlignmentRight;
        panelLabel(v,@"Curve shape",NSMakeRect(20,26,108,20));
        _curves=[[NSPopUpButton alloc] initWithFrame:NSMakeRect(128,20,316,28) pullsDown:NO];
        [_curves addItemsWithTitles:@[@"Smooth · raised cosine",@"Linear",@"Exponential"]];
        [_curves setAccessibilityLabel:@"Curve shape"]; _curves.target=self; _curves.action=@selector(chooseCurve:); [v addSubview:_curves];
        [self refresh];
    }
    return self;
}
- (void)choosePreview:(id)sender { (void)sender; [self refresh]; }
- (void)choosePreset:(NSSegmentedControl *)sender {
    NSInteger i=sender.selectedSegment; if (i<0 || i>2) return;
    static const uint8_t ms[]={2,5,10};
    ToneSettings t=_engine.toneSettings; t.riseMs=t.fallMs=ms[i]; _engine.toneSettings=t; [self refresh];
}
- (void)editRamp:(NSSlider *)sender {
    ToneSettings t=_engine.toneSettings; uint8_t ms=(uint8_t)lround(sender.doubleValue);
    if (sender==_rise) t.riseMs=ms; else t.fallMs=ms;
    _engine.toneSettings=t; [self refresh];
}
- (void)chooseCurve:(NSPopUpButton *)sender {
    ToneSettings t=_engine.toneSettings; t.curve=(uint8_t)sender.indexOfSelectedItem;
    _engine.toneSettings=t; [self refresh];
}
- (void)refresh {
    ToneSettings t=_engine.toneSettings; BOOL dah=_length.selectedSegment==1;
    _rise.doubleValue=t.riseMs; _fall.doubleValue=t.fallMs;
    _riseNumber.stringValue=[NSString stringWithFormat:@"%u ms",t.riseMs];
    _fallNumber.stringValue=[NSString stringWithFormat:@"%u ms",t.fallMs];
    NSInteger preset=-1;
    if (t.riseMs==t.fallMs) {
        if (t.riseMs==2) preset=0;
        else if (t.riseMs==5) preset=1;
        else if (t.riseMs==10) preset=2;
    }
    for (NSInteger i=0;i<_presets.segmentCount;i++) [_presets setSelected:i==preset forSegment:i];
    [_curves selectItemAtIndex:t.curve];
    _duration.stringValue=[NSString stringWithFormat:@"%u WPM  ·  %.1f ms %@",t.wpm,1200.0*(dah?3:1)/t.wpm,dah?@"dah":@"dit"];
    _preview.tone=t; _preview.dah=dah;
    [_preview setAccessibilityLabel:[NSString stringWithFormat:@"%@, %u ms rise, %u ms fall, %@",_duration.stringValue,t.riseMs,t.fallMs,_curves.titleOfSelectedItem]];
    [_preview setNeedsDisplay:YES];
}
@end
