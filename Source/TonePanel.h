#import <AppKit/AppKit.h>
@class MorseEngine;

@interface TonePanel : NSWindowController
- (instancetype)initWithEngine:(MorseEngine *)engine;
- (void)refresh;
@end
