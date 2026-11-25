#import <Foundation/Foundation.h>
@interface Website : NSObject
- (void)exchange:(NSString *)action payload:(NSDictionary *)payload reply:(void (^)(NSDictionary *))reply;
@end
