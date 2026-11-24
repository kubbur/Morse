#import "VBandTarget.h"
#import <CoreGraphics/CoreGraphics.h>
#import <Carbon/Carbon.h>
#include <IOKit/hidsystem/IOLLEvent.h>

unsigned vbandHeldControls(void) {
    return (CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState,kVK_Control) ? 1u : 0u) |
           (CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState,kVK_RightControl) ? 2u : 0u);
}

@interface VBandTarget ()
@property (copy) void (^contacts)(unsigned);
@property (copy) void (^stopped)(void);
@end

static CGEventRef changed(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
    (void)proxy;
    __attribute__((objc_precise_lifetime)) VBandTarget *target=(__bridge VBandTarget *)context;
    if (type==kCGEventTapDisabledByTimeout || type==kCGEventTapDisabledByUserInput) {
        target.stopped();
    } else if (event && (CGEventGetFlags(event)&kCGEventFlagMaskControl) &&
               (type==kCGEventKeyDown || (CGEventGetFlags(event)&(kCGEventFlagMaskAlternate|kCGEventFlagMaskCommand|kCGEventFlagMaskShift)))) {
        // A shortcut in the chosen application cancels typing. No text is read.
        target.stopped();
    } else if (type==kCGEventFlagsChanged && event) {
        int64_t key=CGEventGetIntegerValueField(event,kCGKeyboardEventKeycode);
        if (key==kVK_Control || key==kVK_RightControl) {
            CGEventFlags flags=CGEventGetFlags(event);
            unsigned mask=((flags & NX_DEVICELCTLKEYMASK) ? 1u : 0u) | ((flags & NX_DEVICERCTLKEYMASK) ? 2u : 0u);
            if (!mask && (flags & kCGEventFlagMaskControl)) mask=vbandHeldControls();
            target.contacts(mask);
        }
    }
    return event;
}

@implementation VBandTarget {
    CFMachPortRef _port;
    CFRunLoopSourceRef _source;
}
- (instancetype)initWithPID:(pid_t)pid contacts:(void (^)(unsigned))contacts stopped:(void (^)(void))stopped {
    if (!(self=[super init])) return nil;
    _contacts=[contacts copy]; _stopped=[stopped copy];
    _port=CGEventTapCreateForPid(pid,kCGHeadInsertEventTap,kCGEventTapOptionDefault,
                                 CGEventMaskBit(kCGEventFlagsChanged)|CGEventMaskBit(kCGEventKeyDown),changed,(__bridge void *)self);
    if (!_port) return nil;
    _source=CFMachPortCreateRunLoopSource(NULL,_port,0);
    if (!_source) return nil;
    CFRunLoopAddSource(CFRunLoopGetMain(),_source,kCFRunLoopCommonModes);
    CGEventTapEnable(_port,true);
    return self;
}
- (void)dealloc {
    if (_source) { CFRunLoopSourceInvalidate(_source); CFRelease(_source); }
    if (_port) { CFMachPortInvalidate(_port); CFRelease(_port); }
}
@end
