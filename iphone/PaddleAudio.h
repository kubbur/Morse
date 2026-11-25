#import <Foundation/Foundation.h>
typedef void (^PhoneReply)(NSDictionary *);
@interface PaddleAudio : NSObject
@property(nonatomic,copy) void (^publish)(NSArray *);
- (NSDictionary *)command:(NSString *)name value:(id)value;
- (NSDictionary *)snapshot;
- (void)suspend;
- (void)resume;
- (void)play:(NSDictionary *)plan reply:(PhoneReply)reply;
- (void)stopPrompt:(NSString *)identifier;
@end
