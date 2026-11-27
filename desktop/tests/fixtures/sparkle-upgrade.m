// Isolated native host for a real Sparkle download, install, termination and relaunch.
#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>
#import "MorseUpdateFeed.h"
#import <sqlite3.h>
#include <unistd.h>

// Exercise the production channel delegate while serving its feed inside the fixture.
@interface FixtureFeed : MorseFeed
@end
@implementation FixtureFeed
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
    NSString *published = [super feedURLStringForUpdater:updater];
    if (self.dev && ![published containsString:@"/download/morse-v2.0.0-dev.1/appcast-mac-"]) exit(10);
    if (!self.dev && published) exit(11);
    return NSBundle.mainBundle.infoDictionary[@"SUFeedURL"];
}
@end

@interface Fixture : NSObject <NSApplicationDelegate, SPUUserDriver>
@property(strong) SPUUpdater *updater;
@property(strong) FixtureFeed *feed;
@end

@implementation Fixture
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    NSDictionary *info=NSBundle.mainBundle.infoDictionary;
    NSString *dir=info[@"MorseFixtureState"];
    if (![info[@"CFBundleIdentifier"] hasPrefix:@"digital.kubbur.morse.upgradetest."] || !dir) exit(2);
    sqlite3 *db=NULL;
    NSString *store=[dir stringByAppendingPathComponent:@"fixture.sqlite"];
    if (sqlite3_open(store.fileSystemRepresentation,&db)!=SQLITE_OK) exit(3);
    if ([info[@"CFBundleShortVersionString"] isEqual:info[@"MorseFixtureIncoming"]]) {
        sqlite3_stmt *query=NULL;
        if (sqlite3_prepare_v2(db,"SELECT xp FROM practice",-1,&query,NULL)!=SQLITE_OK ||
            sqlite3_step(query)!=SQLITE_ROW || sqlite3_column_int(query,0)!=37) exit(4);
        sqlite3_finalize(query); sqlite3_close(db);
        [@"2" writeToFile:[dir stringByAppendingPathComponent:@"relaunched"] atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        exit(0);
    }
    if (sqlite3_exec(db,"CREATE TABLE practice(xp INTEGER); INSERT INTO practice VALUES (37)",NULL,NULL,NULL)!=SQLITE_OK) exit(5);
    sqlite3_close(db);
    self.feed=[FixtureFeed new];
    self.feed.dev=[info[@"MorseFixtureDev"] boolValue];
    self.feed.version=self.feed.dev ? info[@"MorseFixtureIncoming"] : @"";
    self.updater=[[SPUUpdater alloc] initWithHostBundle:NSBundle.mainBundle applicationBundle:NSBundle.mainBundle userDriver:self delegate:self.feed];
    NSError *error=nil;
    if (![self.updater startUpdater:&error]) { fprintf(stderr,"%s\n",error.localizedDescription.UTF8String); exit(6); }
    [self.updater checkForUpdates];
}
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)req reply:(void (^)(SUUpdatePermissionResponse *))reply {
    reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancel {}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    if (![item.displayVersionString isEqual:NSBundle.mainBundle.infoDictionary[@"MorseFixtureIncoming"]]) exit(7);
    reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)err {}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))ack { fprintf(stderr,"%s\n",error.localizedDescription.UTF8String); exit(8); }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))ack { fprintf(stderr,"%s\n",error.localizedDescription.UTF8String); exit(9); }
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancel {}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length {}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {}
- (void)showDownloadDidStartExtractingUpdate {}
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply { reply(SPUUserUpdateChoiceInstall); }
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))ack { ack(); }
- (void)dismissUpdateInstallation {}
@end

int main(void) { @autoreleasepool {
    NSApplication *app=[NSApplication sharedApplication];
    Fixture *delegate=[Fixture new];
    app.delegate=delegate;
    [app run];
    return 0;
} }
