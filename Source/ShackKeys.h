#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

// Only the configured key codes produce contacts. No event text leaves the helper.
@interface ShackKeys : NSObject
- (instancetype)initWithChoice:(NSDictionary *)choice contact:(void (^)(unsigned mask,double at))contact
                   interrupted:(void (^)(void))interrupted;
- (BOOL)start;
- (void)stop;
@end
