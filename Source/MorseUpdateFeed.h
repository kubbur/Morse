#import <Sparkle/Sparkle.h>

@interface MorseFeed : NSObject <SPUUpdaterDelegate>
@property BOOL dev;
@property(copy) NSString *version;
@end
