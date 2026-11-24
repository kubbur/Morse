#import <AppKit/AppKit.h>
#import "MorseEngine.h"
#import "PaddleBridge.h"
#import "TypingKeys.h"
#import "TonePanel.h"

@interface ContactTile : NSView
@property (copy) NSString *contactName;
@property (nonatomic) BOOL pressed;
@end
@implementation ContactTile
- (BOOL)isFlipped { return YES; }
- (void)setPressed:(BOOL)pressed { _pressed=pressed; [self setNeedsDisplay:YES]; }
- (void)drawRect:(NSRect)rect {
    (void)rect;
    NSColor *green=[NSColor colorWithSRGBRed:.24 green:.82 blue:.65 alpha:1];
    NSBezierPath *tile=[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds,1,1) xRadius:11 yRadius:11];
    [(_pressed ? green : NSColor.controlBackgroundColor) setFill]; [tile fill];
    [(_pressed ? green : NSColor.separatorColor) setStroke]; [tile stroke];
    NSColor *ink=_pressed ? [NSColor colorWithSRGBRed:.045 green:.18 blue:.14 alpha:1] : NSColor.labelColor;
    [_contactName drawAtPoint:NSMakePoint(16,11) withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:17 weight:NSFontWeightSemibold],NSForegroundColorAttributeName:ink}];
    [(_pressed ? @"Pressed" : @"Released") drawAtPoint:NSMakePoint(16,39) withAttributes:
        @{NSFontAttributeName:[NSFont systemFontOfSize:13], NSForegroundColorAttributeName:(_pressed ? ink : NSColor.secondaryLabelColor)}];
    BOOL dot=[_contactName isEqual:@"Dit"];
    NSRect symbol=NSMakeRect(self.bounds.size.width-(dot ? 27 : 42),18,dot ? 8 : 23,8);
    [(_pressed ? ink : NSColor.tertiaryLabelColor) setFill];
    [[NSBezierPath bezierPathWithRoundedRect:symbol xRadius:4 yRadius:4] fill];
}
@end

@interface AppDelegate : NSObject <NSApplicationDelegate,NSTextFieldDelegate>
@end
@implementation AppDelegate {
    NSWindow *_window;
    MorseEngine *_engine;
    PaddleBridge *_bridge;
    NSTextField *_status, *_playing, *_trainer, *_webStatus;
    NSTextField *_connection, *_inputTitle, *_inputHelp;
    NSButton *_calibrateInput, *_captureInput, *_boostInput, *_automaticInput;
    NSPanel *_inputSheet;
    PaddleCalibrationStep _inputStep;
    BOOL _adapterConnected, _sawPress, _sawRelease;
    NSTextField *_volumeTitle, *_volumeValue, *_typingStatus;
    NSButton *_unmuteButton;
    NSTextField *_speedField, *_pitchField, *_spacingField;
    NSStepper *_speedStepper, *_spacingStepper;
    NSButton *_farnsworth;
    NSPopUpButton *_wordSpaces;
    NSSlider *_pitchSlider;
    TonePanel *_tonePanel;
    NSButton *_typingSwitch, *_privacyButton;
    NSTimer *_typingTimer;
    BOOL _canType;
    NSTimeInterval _nextPermissionCheck;
    NSPopUpButton *_outputs;
    ContactTile *_dit, *_dah;
    NSArray *_options;
    NSString *_webError, *_allowedOrigin;
    NSUInteger _connected;
}
static NSTextField *label(NSView *view, NSString *text, NSRect frame, CGFloat size, BOOL bold) {
    NSTextField *f=[NSTextField labelWithString:text];
    f.frame=frame; f.font=[NSFont systemFontOfSize:size weight:bold ? NSFontWeightSemibold : NSFontWeightRegular];
    f.lineBreakMode=NSLineBreakByTruncatingTail;
    if (!bold) f.textColor=NSColor.secondaryLabelColor;
    [view addSubview:f]; return f;
}
static NSTextField *numberField(NSView *view, NSString *name, NSRect frame, NSInteger low, NSInteger high, id target, SEL action) {
    NSTextField *field=[[NSTextField alloc] initWithFrame:frame];
    NSNumberFormatter *format=[NSNumberFormatter new]; format.numberStyle=NSNumberFormatterDecimalStyle;
    format.usesGroupingSeparator=NO; format.allowsFloats=NO; format.minimum=@(low); format.maximum=@(high);
    field.formatter=format; field.alignment=NSTextAlignmentRight; field.cell.sendsActionOnEndEditing=YES;
    field.target=target; field.action=action; [field setAccessibilityLabel:name];
    field.toolTip=[NSString stringWithFormat:@"%@ (%ld–%ld)",name,(long)low,(long)high];
    [view addSubview:field]; return field;
}
- (void)menus {
    NSMenu *bar=[NSMenu new], *appMenu=[NSMenu new], *edit=[NSMenu new], *windows=[NSMenu new];
    for (NSMenu *m in @[appMenu,edit,windows]) {
        NSMenuItem *i=[NSMenuItem new]; [bar addItem:i]; i.submenu=m;
    }
    appMenu.title=@"Morse Paddle"; edit.title=@"Edit"; windows.title=@"Window";
    [appMenu addItemWithTitle:@"Quit Morse Paddle" action:@selector(terminate:) keyEquivalent:@"q"];
    [edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    [windows addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [windows addItemWithTitle:@"Close" action:@selector(performClose:) keyEquivalent:@"w"];
    NSApp.mainMenu=bar; NSApp.windowsMenu=windows;
}
- (void)applicationDidFinishLaunching:(NSNotification *)note {
    (void)note; [self menus];
    _engine=[MorseEngine new];
    _engine.outputChoice=[NSUserDefaults.standardUserDefaults stringForKey:@"sidetoneOutput"] ?: @"auto";
    NSNumber *volume=[NSUserDefaults.standardUserDefaults objectForKey:@"sidetoneVolume"];
    if ([volume isKindOfClass:NSNumber.class]) _engine.sidetoneVolume=(unsigned)MAX(0,MIN(100,volume.integerValue));
    _bridge=[[PaddleBridge alloc] initWithResources:[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"web"]];
    ToneSettings tone=_engine.toneSettings;
    NSRect panel=NSMakeRect(0,0,462,654);
    _window=[[NSWindow alloc] initWithContentRect:panel
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable
        backing:NSBackingStoreBuffered defer:NO];
    _window.title=@"Morse Paddle"; _window.releasedWhenClosed=NO;
    [_window setFrameAutosaveName:@"MorsePaddleMain"]; [_window setContentSize:panel.size]; [_window center];
    NSView *v=_window.contentView;
    _connection=label(v,@"Checking wired adapter…",NSMakeRect(20,617,422,23),15,YES);
    _status=label(v,@"Looking for the paddle…",NSMakeRect(20,583,274,23),13,NO);
    _calibrateInput=[NSButton buttonWithTitle:@"Calibrate input…" target:self action:@selector(openInputCalibration:)];
    _calibrateInput.frame=NSMakeRect(296,579,147,29); _calibrateInput.enabled=NO; [v addSubview:_calibrateInput];
    _dit=[[ContactTile alloc] initWithFrame:NSMakeRect(20,501,205,67)]; _dit.contactName=@"Dit";
    _dah=[[ContactTile alloc] initWithFrame:NSMakeRect(237,501,205,67)]; _dah.contactName=@"Dah";
    for (ContactTile *tile in @[_dit,_dah]) {
        [tile setAccessibilityElement:YES]; [tile setAccessibilityRole:NSAccessibilityStaticTextRole];
        [tile setAccessibilityLabel:tile.contactName]; [tile setAccessibilityValue:@"Released"]; [v addSubview:tile];
    }
    NSButton *swap=[NSButton checkboxWithTitle:@"Swap dit and dah" target:self action:@selector(changePaddleOrder:)];
    swap.frame=NSMakeRect(19,466,166,23);
    swap.state=_engine.paddlesSwapped ? NSControlStateValueOn : NSControlStateValueOff;
    swap.toolTip=@"Change which paddle sends a dot. Release both paddles to apply a change made while keying.";
    [v addSubview:swap]; [self showPaddleOrder:_engine.paddlesSwapped];
    label(v,@"Character speed",NSMakeRect(190,467,109,19),13,NO).alignment=NSTextAlignmentRight;
    _speedField=numberField(v,@"Keyer speed in WPM",NSMakeRect(302,465,53,23),MinKeyerWPM,MaxKeyerWPM,self,@selector(changeSpeed:));
    _speedStepper=[[NSStepper alloc] initWithFrame:NSMakeRect(357,463,20,27)];
    _speedStepper.minValue=MinKeyerWPM; _speedStepper.maxValue=MaxKeyerWPM; _speedStepper.increment=1;
    _speedStepper.valueWraps=NO; _speedStepper.target=self; _speedStepper.action=@selector(changeSpeed:);
    [_speedStepper setAccessibilityLabel:@"Adjust keyer speed"]; [v addSubview:_speedStepper];
    label(v,@"WPM",NSMakeRect(387,467,55,19),13,NO);
    _farnsworth=[NSButton checkboxWithTitle:@"Farnsworth spacing" target:self action:@selector(changeSpacing:)];
    _farnsworth.frame=NSMakeRect(19,430,170,23); [v addSubview:_farnsworth];
    label(v,@"Effective speed",NSMakeRect(190,431,109,19),13,NO).alignment=NSTextAlignmentRight;
    _spacingField=numberField(v,@"Farnsworth effective WPM",NSMakeRect(302,429,53,23),MinKeyerWPM,MaxKeyerWPM,self,@selector(changeSpacing:));
    _spacingStepper=[[NSStepper alloc] initWithFrame:NSMakeRect(357,427,20,27)];
    _spacingStepper.minValue=MinKeyerWPM; _spacingStepper.increment=1; _spacingStepper.valueWraps=NO;
    _spacingStepper.target=self; _spacingStepper.action=@selector(changeSpacing:);
    [_spacingStepper setAccessibilityLabel:@"Adjust Farnsworth effective WPM"]; [v addSubview:_spacingStepper];
    label(v,@"WPM",NSMakeRect(387,431,55,19),13,NO); [self refreshTiming];
    label(v,@"Sidetone",NSMakeRect(20,396,137,20),14,YES);
    NSButton *envelope=[NSButton buttonWithTitle:@"Tone envelope…" target:self action:@selector(openEnvelope:)];
    envelope.frame=NSMakeRect(296,391,147,29); [v addSubview:envelope];
    _outputs=[[NSPopUpButton alloc] initWithFrame:NSMakeRect(18,363,426,28) pullsDown:NO];
    _outputs.target=self; _outputs.action=@selector(selectOutput:);
    [_outputs setAccessibilityLabel:@"Sidetone output"]; [v addSubview:_outputs];
    _playing=label(v,@"Looking for audio outputs…",NSMakeRect(20,339,422,19),12,NO);
    label(v,@"Sidetone pitch",NSMakeRect(20,304,110,20),13,YES);
    _pitchSlider=[NSSlider sliderWithValue:tone.pitchHz minValue:MinToneHz maxValue:MaxToneHz target:self action:@selector(changePitch:)];
    _pitchSlider.continuous=YES; _pitchSlider.frame=NSMakeRect(132,301,225,25);
    [_pitchSlider setAccessibilityLabel:@"Sidetone pitch in Hz"]; [v addSubview:_pitchSlider];
    _pitchField=numberField(v,@"Sidetone pitch in Hz",NSMakeRect(364,301,52,23),MinToneHz,MaxToneHz,self,@selector(changePitch:));
    _pitchField.integerValue=tone.pitchHz; label(v,@"Hz",NSMakeRect(422,304,23,19),13,NO);
    _volumeTitle=label(v,@"Paddle volume",NSMakeRect(20,268,110,20),13,YES);
    NSSlider *slider=[NSSlider sliderWithValue:_engine.sidetoneVolume minValue:0 maxValue:100 target:self action:@selector(changeVolume:)];
    slider.frame=NSMakeRect(132,265,236,25); slider.continuous=YES;
    [slider setAccessibilityLabel:@"Paddle sidetone volume"]; [v addSubview:slider];
    _volumeValue=label(v,@"",NSMakeRect(386,268,56,20),13,NO); _volumeValue.alignment=NSTextAlignmentRight;
    _unmuteButton=[NSButton buttonWithTitle:@"Unmute" target:self action:@selector(unmuteSidetone:)];
    _unmuteButton.frame=NSMakeRect(370,263,76,28);
    [_unmuteButton setAccessibilityLabel:@"Unmute paddle sidetone"]; [v addSubview:_unmuteButton];
    [self volumeLabel];
    NSBox *typingLine=[[NSBox alloc] initWithFrame:NSMakeRect(20,250,422,1)];
    typingLine.boxType=NSBoxSeparator; [v addSubview:typingLine];
    _typingSwitch=[NSButton checkboxWithTitle:@"Type into focused app" target:self action:@selector(toggleTyping:)];
    _typingSwitch.frame=NSMakeRect(19,217,260,23); _typingSwitch.state=NSControlStateValueOff; [v addSubview:_typingSwitch];
    _privacyButton=[NSButton buttonWithTitle:@"Settings…" target:self action:@selector(openPrivacy:)];
    _privacyButton.frame=NSMakeRect(338,214,105,28); _privacyButton.hidden=YES; [v addSubview:_privacyButton];
    _typingStatus=label(v,@"Off · paddle available for practice",NSMakeRect(20,189,422,20),12,NO);
    label(v,@"Word spaces",NSMakeRect(20,152,100,20),13,YES);
    _wordSpaces=[[NSPopUpButton alloc] initWithFrame:NSMakeRect(130,148,313,28) pullsDown:NO];
    [_wordSpaces addItemsWithTitles:@[@"Manual · .-.- or Space key",@"Automatic · timed word gap"]];
    [_wordSpaces selectItemAtIndex:(tone.options&TimedWordSpaces)?1:0];
    _wordSpaces.target=self; _wordSpaces.action=@selector(changeWordSpaces:);
    [_wordSpaces setAccessibilityLabel:@"Word spaces when typing"]; [v addSubview:_wordSpaces];
    NSBox *separator=[[NSBox alloc] initWithFrame:NSMakeRect(20,135,422,1)]; separator.boxType=NSBoxSeparator; [v addSubview:separator];
    label(v,@"Web app",NSMakeRect(20,103,160,20),14,YES);
    _trainer=[[NSTextField alloc] initWithFrame:NSMakeRect(20,71,322,25)];
    _trainer.placeholderString=@"https://your-trainer.example"; _trainer.delegate=self;
    _trainer.stringValue=[NSUserDefaults.standardUserDefaults stringForKey:@"trainerURL"] ?: @"";
    [_trainer setAccessibilityLabel:@"Web app URL"]; _trainer.target=self; _trainer.action=@selector(linkTrainer:);
    [v addSubview:_trainer];
    NSButton *link=[NSButton buttonWithTitle:@"Link" target:self action:@selector(linkTrainer:)];
    link.frame=NSMakeRect(349,67,95,32); [v addSubview:link];
    _webStatus=label(v,@"",NSMakeRect(20,45,421,18),12,NO);
    NSButton *test=[NSButton buttonWithTitle:@"Open connection test" target:self action:@selector(openTest:)];
    test.frame=NSMakeRect(16,10,166,29); [v addSubview:test];
    _allowedOrigin=[PaddleBridge originForURL:[NSURL URLWithString:_trainer.stringValue]];
    [_bridge allowOrigin:_allowedOrigin];
    __weak AppDelegate *weak=self;
    MorseEngine *engine=_engine;
    _engine.adapterConnectionChanged=^(BOOL connected) { [weak adapterConnected:connected]; };
    _engine.inputCalibrationChanged=^(PaddleCalibrationStep step,BOOL sampling,BOOL boosted) {
        [weak showInputStep:step sampling:sampling boosted:boosted];
    };
    _bridge.sidetoneMuteChanged=^(BOOL muted) {
        engine.sidetoneMuted=muted;
        dispatch_async(dispatch_get_main_queue(),^{[weak volumeLabel];});
    };
    _bridge.clientCountChanged=^(NSUInteger count){ AppDelegate *app=weak; if (app) { app->_connected=count; [app webLabel]; }};
    _engine.stateChanged=^(NSString *phase,NSString *detail,unsigned mask,double time,BOOL swapped) {
        AppDelegate *app=weak; if (!app) return;
        [app observePaddlePhase:phase mask:mask];
        app->_status.stringValue=detail; app->_status.toolTip=detail;
        app->_dit.pressed=(mask&1)!=0; app->_dah.pressed=(mask&2)!=0;
        [app showPaddleOrder:mask ? swapped : app->_engine.paddlesSwapped];
        [app->_dit setAccessibilityValue:app->_dit.pressed?@"Pressed":@"Released"];
        [app->_dah setAccessibilityValue:app->_dah.pressed?@"Pressed":@"Released"];
        [app->_bridge publish:phase mask:mask timeMs:time];
    };
    _engine.outputsChanged=^(NSArray *devices,NSString *route){[weak showOutputs:devices route:route];};
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(frontAppChanged:)
        name:NSWorkspaceDidActivateApplicationNotification object:nil];
    [self showOutputs:@[] route:@"Looking for audio outputs…"];
    NSError *error=nil;
    if (![_bridge start:&error]) { _webError=[NSString stringWithFormat:@"Web connection unavailable · %@",error.localizedDescription]; test.enabled=NO; }
    [self webLabel]; [_window makeKeyAndOrderFront:nil]; [_window makeFirstResponder:nil]; [NSApp activateIgnoringOtherApps:YES];
    [_engine start];
}
- (void)showOutputs:(NSArray *)items route:(NSString *)route {
    _playing.stringValue=route; _playing.toolTip=route;
    if ([_options isEqual:items]) return;
    _options=[items copy]; [_outputs removeAllItems];
    [_outputs addItemWithTitle:@"Automatic"]; _outputs.lastItem.representedObject=@"auto";
    [_outputs addItemWithTitle:@"Mac speakers"]; _outputs.lastItem.representedObject=@"speakers";
    for (NSDictionary *o in items) {
        [_outputs addItemWithTitle:o[@"name"]]; _outputs.lastItem.representedObject=o[@"id"];
    }
    NSString *selected=_engine.outputChoice;
    NSInteger i=[_outputs indexOfItemWithRepresentedObject:selected];
    if (i<0) {
        NSString *name=[NSUserDefaults.standardUserDefaults stringForKey:@"sidetoneName"] ?: @"Bluetooth headphones";
        [_outputs addItemWithTitle:[name stringByAppendingString:@" (disconnected)"]]; _outputs.lastItem.representedObject=selected;
        i=_outputs.numberOfItems-1;
    }
    [_outputs selectItemAtIndex:i];
}
- (void)selectOutput:(id)sender {
    (void)sender;
    _engine.outputChoice=_outputs.selectedItem.representedObject;
    [NSUserDefaults.standardUserDefaults setObject:_engine.outputChoice forKey:@"sidetoneOutput"];
    [NSUserDefaults.standardUserDefaults setObject:_outputs.selectedItem.title forKey:@"sidetoneName"];
}
- (void)showPaddleOrder:(BOOL)swapped {
    NSPoint dit=_dit.frame.origin, dah=_dah.frame.origin;
    if ((dit.x>dah.x)==swapped) return;
    [_dit setFrameOrigin:dah]; [_dah setFrameOrigin:dit];
}
- (void)changePaddleOrder:(NSButton *)sender {
    _engine.paddlesSwapped=sender.state==NSControlStateValueOn;
    if (!_dit.pressed && !_dah.pressed) [self showPaddleOrder:_engine.paddlesSwapped];
}
- (void)adapterConnected:(BOOL)connected {
    _adapterConnected=connected; _sawPress=NO; _sawRelease=NO;
    if (!connected) _calibrateInput.enabled=NO;
    [self showConnection];
}
- (void)observePaddlePhase:(NSString *)phase mask:(unsigned)mask {
    BOOL ready=[phase isEqual:@"ready"];
    _calibrateInput.enabled=_adapterConnected && (ready || [phase isEqual:@"calibrating"]);
    if (ready && mask) _sawPress=YES;
    if (ready && !mask && _sawPress) { _sawRelease=YES; _sawPress=NO; }
    if (!ready) _sawPress=NO;
    if ([phase isEqual:@"disconnected"]) _sawRelease=NO;
    [self showConnection];
}
- (void)showConnection {
    if (!_adapterConnected) _connection.stringValue=@"Adapter disconnected";
    else if (_sawRelease) _connection.stringValue=@"Adapter connected · paddle signal seen";
    else _connection.stringValue=@"Adapter connected · paddle signal unverified";
    _connection.toolTip=@"The Mac detects the wired adapter. A paddle press and release confirms signal from the switches.";
}
- (void)openInputCalibration:(id)sender {
    (void)sender;
    if (_inputSheet.sheetParent) return;
    if (!_inputSheet) {
        _inputSheet=[[NSPanel alloc] initWithContentRect:NSMakeRect(0,0,434,206)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        _inputSheet.title=@"Paddle input calibration";
        NSView *v=_inputSheet.contentView;
        _inputTitle=label(v,@"",NSMakeRect(20,163,395,25),16,YES);
        _inputHelp=[NSTextField wrappingLabelWithString:@""];
        _inputHelp.frame=NSMakeRect(20,87,394,63); [v addSubview:_inputHelp];
        _boostInput=[NSButton checkboxWithTitle:@"Boost wired sensing tones by 6 dB" target:nil action:NULL];
        _boostInput.toolTip=@"Only the two tones sent to the wired adapter are boosted.";
        _boostInput.frame=NSMakeRect(19,64,396,22); [v addSubview:_boostInput];
        _automaticInput=[NSButton buttonWithTitle:@"Use automatic levels" target:self action:@selector(automaticInput:)];
        _automaticInput.frame=NSMakeRect(14,14,157,30); [v addSubview:_automaticInput];
        NSButton *cancel=[NSButton buttonWithTitle:@"Close" target:self action:@selector(closeInputCalibration:)];
        cancel.frame=NSMakeRect(218,14,80,30); [v addSubview:cancel];
        _captureInput=[NSButton buttonWithTitle:@"Measure" target:self action:@selector(measureInput:)];
        _captureInput.keyEquivalent=@"\r"; _captureInput.frame=NSMakeRect(301,14,117,30); [v addSubview:_captureInput];
    }
    _inputStep=InputInactive; _inputTitle.stringValue=@"Preparing input calibration…"; _inputHelp.stringValue=@"";
    _captureInput.enabled=NO; _boostInput.hidden=YES; _automaticInput.hidden=YES;
    [_window beginSheet:_inputSheet completionHandler:nil];
    [_engine beginInputCalibration];
}
- (void)showInputStep:(PaddleCalibrationStep)step sampling:(BOOL)sampling boosted:(BOOL)boosted {
    if (step==InputCalibrated && _adapterConnected) { _sawRelease=YES; [self showConnection]; }
    if (!_inputSheet.sheetParent) return;
    _inputStep=step;
    _captureInput.enabled=!sampling; _captureInput.title=sampling ? @"Measuring…" : @"Measure";
    _boostInput.hidden=step!=InputReleased; _boostInput.enabled=!sampling;
    _boostInput.state=boosted ? NSControlStateValueOn : NSControlStateValueOff;
    _automaticInput.hidden=step!=InputReleased && step!=InputOverlap; _automaticInput.enabled=!sampling;
    switch (step) {
        case InputReleased:
            _inputTitle.stringValue=@"1 of 4 · Move the converter";
            _inputHelp.stringValue=@"Release both paddles. Click Measure and gently move the converter and cable for two seconds. The optional boost affects the wired adapter only."; break;
        case InputFirst: case InputOther:
            _inputTitle.stringValue=step==InputFirst ? @"2 of 4 · Hold either paddle" : @"3 of 4 · Hold the other paddle";
            _inputHelp.stringValue=step==InputFirst ? @"Press just one paddle. Click Measure and keep holding until the next instruction." :
                @"Release the first paddle and press the other one by itself. Click Measure and keep holding."; break;
        case InputBoth:
            _inputTitle.stringValue=@"4 of 4 · Squeeze both paddles";
            _inputHelp.stringValue=@"Hold both paddles together. Click Measure and keep holding until calibration finishes."; break;
        case InputCalibrated:
            _inputTitle.stringValue=@"Paddle input calibrated"; _captureInput.title=@"Done";
            _inputHelp.stringValue=@"Release both paddles to resume. The Mac saved these levels for this wired input and output."; break;
        case InputOverlap:
            _inputTitle.stringValue=@"Movement and presses overlapped"; _captureInput.title=@"Try again";
            _inputHelp.stringValue=@"The measurements could not distinguish both switches reliably. Your previous settings are still active. Repeat with a fully seated plug and hold each requested position."; break;
        case InputUnavailable:
            _inputTitle.stringValue=@"Wired input unavailable"; _captureInput.title=@"Done";
            _inputHelp.stringValue=@"Connect the adapter and wait for the paddle to be ready before measuring."; break;
        case InputInactive: break;
    }
}
- (void)measureInput:(id)sender {
    (void)sender;
    if (_inputStep==InputCalibrated || _inputStep==InputUnavailable) { [self closeInputCalibration:nil]; return; }
    _captureInput.enabled=NO;
    if (_inputStep==InputOverlap) [_engine beginInputCalibration];
    else [_engine sampleInputCalibrationBoosted:_boostInput.state==NSControlStateValueOn];
}
- (void)closeInputCalibration:(id)sender {
    (void)sender; [_engine cancelInputCalibration]; [_window endSheet:_inputSheet];
}
- (void)automaticInput:(id)sender {
    (void)sender; [_engine useAutomaticInputLevels]; [_window endSheet:_inputSheet];
}
- (void)openEnvelope:(id)sender {
    (void)sender; if (!_tonePanel) _tonePanel=[[TonePanel alloc] initWithEngine:_engine];
    [_tonePanel refresh]; [_tonePanel showWindow:nil]; [_tonePanel.window makeKeyAndOrderFront:nil];
}
- (void)refreshTiming {
    ToneSettings t=_engine.toneSettings; BOOL on=(t.options&UseFarnsworth)!=0;
    _speedField.integerValue=t.wpm; _speedStepper.integerValue=t.wpm;
    _farnsworth.state=on ? NSControlStateValueOn : NSControlStateValueOff;
    ((NSNumberFormatter *)_spacingField.formatter).maximum=@(t.wpm); _spacingStepper.maxValue=t.wpm;
    _spacingField.integerValue=on ? t.spacingWpm : t.wpm; _spacingStepper.integerValue=_spacingField.integerValue;
    _spacingField.enabled=on; _spacingStepper.enabled=on;
    [_bridge setKeyerWPM:t.wpm effective:effectiveWPM(t)]; [_tonePanel refresh];
}
- (void)changeSpeed:(NSControl *)sender {
    ToneSettings t=_engine.toneSettings; NSInteger speed=sender.integerValue;
    if (speed>=MinKeyerWPM && speed<=MaxKeyerWPM) { t.wpm=(uint8_t)speed; _engine.toneSettings=t; }
    [self refreshTiming];
}
- (void)changeSpacing:(NSControl *)sender {
    ToneSettings t=_engine.toneSettings;
    if (sender==_farnsworth) {
        if (_farnsworth.state==NSControlStateValueOn) t.options|=UseFarnsworth; else t.options&=~UseFarnsworth;
    } else if (sender.integerValue>=MinKeyerWPM && sender.integerValue<=t.wpm) t.spacingWpm=(uint8_t)sender.integerValue;
    _engine.toneSettings=t; [self refreshTiming];
}
- (void)changeWordSpaces:(NSPopUpButton *)sender {
    ToneSettings t=_engine.toneSettings;
    if (sender.indexOfSelectedItem==1) t.options|=TimedWordSpaces; else t.options&=~TimedWordSpaces;
    _engine.toneSettings=t;
}
- (void)changePitch:(NSControl *)sender {
    ToneSettings t=_engine.toneSettings;
    NSInteger pitch=lround(sender.doubleValue);
    if (pitch>=MinToneHz && pitch<=MaxToneHz) { t.pitchHz=(uint16_t)pitch; _engine.toneSettings=t; }
    _pitchSlider.integerValue=t.pitchHz; _pitchField.integerValue=t.pitchHz;
}
- (void)volumeLabel {
    BOOL muted=_engine.sidetoneMuted;
    NSString *percent=[NSString stringWithFormat:@"%u%%",_engine.sidetoneVolume];
    _volumeValue.stringValue=percent; _volumeValue.hidden=muted; _unmuteButton.hidden=!muted;
    _volumeTitle.stringValue=muted ? @"Paddle muted" : @"Paddle volume";
    _volumeTitle.toolTip=muted ? [NSString stringWithFormat:@"Muted by the web app. Paddle volume: %@.",percent] : nil;
}
- (void)unmuteSidetone:(id)sender { (void)sender; [_bridge unmuteSidetone]; }
- (void)changeVolume:(NSSlider *)slider {
    _engine.sidetoneVolume=(unsigned)lround(slider.doubleValue);
    [NSUserDefaults.standardUserDefaults setInteger:_engine.sidetoneVolume forKey:@"sidetoneVolume"]; [self volumeLabel];
}
- (void)updateTypingTarget {
    BOOL wanted=_typingSwitch.state==NSControlStateValueOn;
    NSRunningApplication *front=NSWorkspace.sharedWorkspace.frontmostApplication;
    pid_t pid=front.processIdentifier;
    BOOL usable=wanted && _canType && pid>0 && pid!=NSProcessInfo.processInfo.processIdentifier;
    [_engine setTypingDestination:usable ? pid : 0];
    _privacyButton.hidden=!wanted || _canType;
    if (!wanted) _typingStatus.stringValue=@"Off · paddle available for practice";
    else if (!_canType) _typingStatus.stringValue=@"Allow Morse Paddle in Privacy & Security → Accessibility.";
    else if (usable) _typingStatus.stringValue=[@"Typing into " stringByAppendingString:front.localizedName ?: @"the focused app"];
    else _typingStatus.stringValue=@"Click a text field in another app and key a letter.";
}
- (void)frontAppChanged:(NSNotification *)note {
    (void)note;
    if (_typingSwitch.state==NSControlStateValueOn) {
        [_engine setTypingDestination:0]; [self updateTypingTarget];
    }
}
- (void)typingTick:(NSTimer *)timer {
    (void)timer;
    NSTimeInterval now=NSProcessInfo.processInfo.systemUptime;
    if (now>=_nextPermissionCheck) {
        _nextPermissionCheck=now+.75; _canType=CGPreflightPostEventAccess();
        [self updateTypingTarget];
    }
    [_engine drainTypedCharacters:^(pid_t pid,char character,BOOL spaceBefore) {
        if (self->_typingSwitch.state!=NSControlStateValueOn || !self->_canType) return;
        if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier!=pid) { [self updateTypingTarget]; return; }
        if (!CGPreflightPostEventAccess()) { self->_canType=NO; [self updateTypingTarget]; return; }
        if (spaceBefore) postTypingKey(pid,' ');
        postTypingKey(pid,character);
    }];
}
- (void)toggleTyping:(id)sender {
    (void)sender;
    [_typingTimer invalidate]; _typingTimer=nil;
    BOOL wanted=_typingSwitch.state==NSControlStateValueOn;
    _canType=wanted && (CGPreflightPostEventAccess() || CGRequestPostEventAccess());
    [self updateTypingTarget];
    if (wanted) {
        _nextPermissionCheck=0;
        _typingTimer=[NSTimer timerWithTimeInterval:.035 target:self selector:@selector(typingTick:) userInfo:nil repeats:YES];
        [NSRunLoop.mainRunLoop addTimer:_typingTimer forMode:NSRunLoopCommonModes];
    }
}
- (void)openPrivacy:(id)sender {
    (void)sender;
    [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]];
}
- (void)webLabel {
    NSString *s=_webError;
    if (!s && _connected) s=[NSString stringWithFormat:@"%lu web connection%@",(unsigned long)_connected,_connected==1?@"":@"s"];
    if (!s && _allowedOrigin) s=[@"Linked to " stringByAppendingString:_allowedOrigin];
    _webStatus.stringValue=s ?: @"Local connection test available"; _webStatus.toolTip=_webStatus.stringValue;
}
- (void)linkTrainer:(id)sender {
    (void)sender;
    NSString *text=[_trainer.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (text.length && ![text containsString:@"://"]) text=[@"https://" stringByAppendingString:text];
    NSURL *url=text.length ? [NSURL URLWithString:text] : nil;
    NSString *origin=[PaddleBridge originForURL:url];
    if (text.length && !origin) { _webStatus.stringValue=@"Enter an HTTPS web app URL, or a localhost development URL."; return; }
    _allowedOrigin=origin; [_bridge allowOrigin:origin];
    [NSUserDefaults.standardUserDefaults setObject:text forKey:@"trainerURL"]; _trainer.stringValue=text;
    [self webLabel]; if (url) [NSWorkspace.sharedWorkspace openURL:url];
}
- (void)openTest:(id)sender { (void)sender; [NSWorkspace.sharedWorkspace openURL:_bridge.localURL]; }
- (BOOL)applicationShouldHandleReopen:(NSApplication *)app hasVisibleWindows:(BOOL)visible {
    (void)app; (void)visible; if (_window.miniaturized) [_window deminiaturize:nil];
    [_window makeKeyAndOrderFront:nil]; return YES;
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)app { (void)app; return NO; }
- (void)application:(NSApplication *)app openURLs:(NSArray<NSURL *> *)urls {
    (void)urls; [self applicationShouldHandleReopen:app hasVisibleWindows:_window.visible];
}
- (void)applicationWillTerminate:(NSNotification *)note {
    (void)note;
    [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self]; [_typingTimer invalidate];
    [_engine setTypingDestination:0]; [_engine stop]; [_bridge stop];
}
@end
int main(void) {
    @autoreleasepool {
        NSApplication *app=NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        __attribute__((objc_precise_lifetime)) AppDelegate *delegate=[AppDelegate new];
        app.delegate=delegate; [app run]; return 0;
    }
}
