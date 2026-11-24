// Run only the signature check from the packaged Squirrel framework. Both
// paths belong to a disposable test. This never starts ShipIt or launches an app.
#import <Foundation/Foundation.h>

@interface RACSignal : NSObject
- (BOOL)waitUntilCompleted:(NSError **)error;
@end
@interface SQRLCodeSignature : NSObject
+ (instancetype)signatureWithBundle:(NSURL *)bundle error:(NSError **)error;
- (RACSignal *)verifyBundleAtURL:(NSURL *)bundle;
@end

int main(int argc, const char **argv) { @autoreleasepool {
    if (argc != 3) return 2;
    NSError *error = nil;
    NSURL *installed = [NSURL fileURLWithPath:@(argv[1]) isDirectory:YES];
    NSURL *incoming = [NSURL fileURLWithPath:@(argv[2]) isDirectory:YES];
    SQRLCodeSignature *signer = [SQRLCodeSignature signatureWithBundle:installed error:&error];
    if (!signer) { fprintf(stderr, "Could not read the test signature.\n"); return 2; }
    return [[signer verifyBundleAtURL:incoming] waitUntilCompleted:&error] ? 0 : 1;
} }
