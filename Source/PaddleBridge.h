#import <Foundation/Foundation.h>

@interface PaddleBridge : NSObject
@property (readonly) NSURL *localURL;
@property (copy) void (^clientCountChanged)(NSUInteger count);
// Runs synchronously under the bridge lock. Apply the audio flag here and queue UI updates.
@property (copy) void (^sidetoneMuteChanged)(BOOL muted);
- (void)unmuteSidetone;
- (void)setKeyerWPM:(unsigned)wpm effective:(unsigned)effective;
+ (NSString *)originForURL:(NSURL *)url;
- (instancetype)initWithResources:(NSURL *)resources;
- (instancetype)initWithResources:(NSURL *)resources port:(uint16_t)port;
- (BOOL)start:(NSError **)error;
- (void)allowOrigin:(NSString *)origin;
- (void)publish:(NSString *)phase mask:(unsigned)mask timeMs:(double)time;
- (void)stop;
@end
