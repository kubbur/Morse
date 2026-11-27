#import "ShackKeys.h"
#import <Carbon/Carbon.h>
#include <IOKit/hidsystem/IOLLEvent.h>

@implementation ShackKeys {
    NSDictionary *_choice;
    void (^_contact)(unsigned,double);
    void (^_interrupted)(void);
    CFMachPortRef _tap;
    CFRunLoopSourceRef _runSource;
    unsigned char _binding[128][2], _held[128];
    BOOL _blocked[128], _vband;
    unsigned _mask;
}
- (instancetype)initWithChoice:(NSDictionary *)choice contact:(void (^)(unsigned,double))contact interrupted:(void (^)(void))interrupted {
    if ((self=[super init])) {
        _choice=[choice copy]; _contact=[contact copy]; _interrupted=[interrupted copy];
        _vband=[choice[@"source"] isEqual:@"vband"];
    }
    return self;
}
- (BOOL)keyHeld:(CGKeyCode)code {
    return CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState,code);
}
- (BOOL)mapKeys {
    memset(_binding,0,sizeof(_binding)); memset(_held,0,sizeof(_held)); memset(_blocked,0,sizeof(_blocked)); _mask=0;
    if (_vband) {
        _binding[kVK_Control][0]=1; _binding[kVK_RightControl][0]=2;
    } else if ([_choice[@"source"] isEqual:@"straight"]) {
        _binding[kVK_Space][0]=_binding[kVK_Space][1]=1;
    } else {
        TISInputSourceRef source=TISCopyCurrentKeyboardLayoutInputSource();
        if (!source) return NO;
        CFDataRef data=TISGetInputSourceProperty(source,kTISPropertyUnicodeKeyLayoutData);
        unsigned found=0;
        if (data) {
            const UCKeyboardLayout *layout=(const UCKeyboardLayout *)CFDataGetBytePtr(data);
            for (UInt16 code=0;code<128;code++) for (unsigned shifted=0;shifted<=1;shifted++) {
                UInt32 dead=0; UniChar chars[8]; UniCharCount length=0;
                if (UCKeyTranslate(layout,code,kUCKeyActionDown,shifted ? shiftKey>>8 : 0,LMGetKbdType(),
                    kUCKeyTranslateNoDeadKeysMask,&dead,8,&length,chars)!=noErr || !length) continue;
                NSString *key=[[[NSString stringWithCharacters:chars length:length] precomposedStringWithCanonicalMapping] lowercaseString];
                unsigned bit=[key isEqual:_choice[@"dit"]] ? 1 : [key isEqual:_choice[@"dah"]] ? 2 : 0;
                _binding[code][shifted]=bit; found|=bit;
            }
        }
        CFRelease(source);
        if (found!=3) return NO;
    }
    for (CGKeyCode code=0;code<128;code++)
        if (_binding[code][0] || _binding[code][1]) _blocked[code]=[self keyHeld:code];
    return YES;
}
- (void)key:(CGKeyCode)code down:(BOOL)down flags:(CGEventFlags)flags at:(double)at {
    if (code>=128 || !(_binding[code][0] || _binding[code][1])) return;
    if (!down) { _blocked[code]=NO; _held[code]=0; }
    else {
        if (_blocked[code] || _held[code]) return;
        CGEventFlags shortcuts=kCGEventFlagMaskCommand|kCGEventFlagMaskAlternate|kCGEventFlagMaskSecondaryFn;
        if (!_vband) shortcuts|=kCGEventFlagMaskControl;
        if (flags & shortcuts) { _blocked[code]=YES; return; }
        _held[code]=_binding[code][!_vband && (flags & kCGEventFlagMaskShift) ? 1 : 0];
    }
    unsigned mask=0;
    for (unsigned i=0;i<128;i++) mask|=_held[i];
    if (mask!=_mask) { _mask=mask; _contact(mask,at); }
}
- (void)event:(CGEventRef)event type:(CGEventType)type {
    if (type==kCGEventTapDisabledByTimeout || type==kCGEventTapDisabledByUserInput) { _interrupted(); return; }
    if (!event || (type!=kCGEventFlagsChanged && CGEventGetIntegerValueField(event,kCGKeyboardEventAutorepeat))) return;
    CGKeyCode code=(CGKeyCode)CGEventGetIntegerValueField(event,kCGKeyboardEventKeycode);
    if (code>=128 || !(_binding[code][0] || _binding[code][1])) return;
    CGEventFlags flags=CGEventGetFlags(event);
    BOOL down=type==kCGEventKeyDown;
    if (_vband) {
        if (type!=kCGEventFlagsChanged) return;
        down=(flags & (code==kVK_Control?NX_DEVICELCTLKEYMASK:NX_DEVICERCTLKEYMASK))!=0;
        if (!down && (flags & kCGEventFlagMaskControl)) down=[self keyHeld:code];
    }
    [self key:code down:down flags:flags at:CGEventGetTimestamp(event)/1e6];
}
static CGEventRef eventTap(CGEventTapProxy proxy,CGEventType type,CGEventRef event,void *context) {
    (void)proxy;
    __attribute__((objc_precise_lifetime)) ShackKeys *keys=(__bridge ShackKeys *)context;
    [keys event:event type:type];
    return event;
}
- (void)layoutChanged:(NSNotification *)note {
    (void)note;
    if (_mask) _contact(0,NSProcessInfo.processInfo.systemUptime*1000);
    if (![self mapKeys]) _interrupted();
}
- (BOOL)start {
    if (!CGPreflightListenEventAccess() || ![self mapKeys]) return NO;
    CGEventMask events=_vband ? CGEventMaskBit(kCGEventFlagsChanged) : CGEventMaskBit(kCGEventKeyDown)|CGEventMaskBit(kCGEventKeyUp);
    _tap=CGEventTapCreate(kCGSessionEventTap,kCGHeadInsertEventTap,kCGEventTapOptionListenOnly,events,eventTap,(__bridge void *)self);
    if (!_tap) return NO;
    _runSource=CFMachPortCreateRunLoopSource(NULL,_tap,0);
    if (!_runSource) { [self stop]; return NO; }
    CFRunLoopAddSource(CFRunLoopGetMain(),_runSource,kCFRunLoopCommonModes);
    CGEventTapEnable(_tap,true);
    [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(layoutChanged:)
        name:(__bridge NSString *)kTISNotifySelectedKeyboardInputSourceChanged object:nil];
    return YES;
}
- (void)stop {
    [NSDistributedNotificationCenter.defaultCenter removeObserver:self];
    if (_runSource) { CFRunLoopSourceInvalidate(_runSource); CFRelease(_runSource); _runSource=NULL; }
    if (_tap) { CFMachPortInvalidate(_tap); CFRelease(_tap); _tap=NULL; }
}
- (void)dealloc { [self stop]; }
@end
