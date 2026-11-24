#import <Foundation/Foundation.h>

// Exists only while write-anywhere is enabled and its current external application has focus.
@interface VBandTarget : NSObject
- (instancetype)initWithPID:(pid_t)pid contacts:(void (^)(unsigned mask))contacts
                    stopped:(void (^)(void))stopped;
@end

unsigned vbandHeldControls(void);
