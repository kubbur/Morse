#import "MorseUpdateFeed.h"

static BOOL Permit(BOOL allowed, NSString *message, NSError **error) {
    if (!allowed && error) *error = [NSError errorWithDomain:@"digital.kubbur.morse.updates" code:1
        userInfo:@{NSLocalizedDescriptionKey:message}];
    return allowed;
}

@implementation MorseFeed
- (NSSet<NSString *> *)allowedChannelsForUpdater:(SPUUpdater *)updater {
    return self.dev ? [NSSet setWithObject:@"dev"] : [NSSet set];
}
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
    if (!self.dev || !self.version.length) return nil;
#if defined(__arm64__)
    NSString *arch = @"arm64";
#else
    NSString *arch = @"x64";
#endif
    return [NSString stringWithFormat:@"https://github.com/kubbur/Morse/releases/download/morse-v%@/appcast-mac-%@.xml", self.version, arch];
}
- (BOOL)updater:(SPUUpdater *)updater mayPerformUpdateCheck:(SPUUpdateCheck)check error:(NSError **)error {
    return Permit(!self.dev || self.version.length > 0, @"Waiting for a published Dev build.", error);
}
- (BOOL)updater:(SPUUpdater *)updater shouldProceedWithUpdate:(SUAppcastItem *)item updateCheck:(SPUUpdateCheck)check error:(NSError **)error {
    BOOL matches = self.dev ? [item.channel isEqual:@"dev"] && [item.displayVersionString isEqual:self.version] : item.channel.length == 0;
    return Permit(matches, @"This update belongs to a different channel or build.", error);
}
@end
