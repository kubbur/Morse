#import <Foundation/Foundation.h>

// The helper's preferences live inside the owning app's resolved userData directory.
@interface DevicePreferences : NSUserDefaults
- (instancetype)initWithDirectory:(NSURL *)directory legacy:(NSDictionary *)legacy error:(NSError **)error;
@end
