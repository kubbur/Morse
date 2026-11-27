// Electron's main thread owns AppKit and this controller for the life of Morse.
#import <Cocoa/Cocoa.h>
#import "MorseUpdateFeed.h"
#include <node_api.h>

static SPUStandardUpdaterController *controller;

static MorseFeed *feed;

static NSString *Argument(napi_env env, napi_value value) {
    char buffer[96];
    size_t size = 0;
    if (napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok || size >= sizeof(buffer) ||
        napi_get_value_string_utf8(env, value, buffer, sizeof(buffer), &size) != napi_ok) return nil;
    return [[NSString alloc] initWithBytes:buffer length:size encoding:NSUTF8StringEncoding];
}

static napi_value Configure(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    bool automatic = false;
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    NSString *channel = argc == 3 ? Argument(env, args[1]) : nil;
    NSString *version = argc == 3 ? Argument(env, args[2]) : nil;
    BOOL dev = [channel isEqual:@"dev"];
    if (argc != 3 || napi_get_value_bool(env, args[0], &automatic) != napi_ok || !NSThread.isMainThread ||
        (!dev && ![channel isEqual:@"stable"]) || !version || (version.length && (!dev ||
        [version rangeOfString:@"^[0-9]+\\.[0-9]+\\.[0-9]+-dev\\.[1-9][0-9]*\\z" options:NSRegularExpressionSearch].location == NSNotFound))) {
        napi_throw_type_error(env, NULL, "Invalid Mac update configuration.");
        return NULL;
    }
    @try {
        if (controller.updater.sessionInProgress && feed.dev != dev) {
            napi_throw_error(env, NULL, "Finish or cancel the active update first.");
            return NULL;
        }
        if (!feed) feed = [MorseFeed new];
        BOOL changed = feed.dev != dev || ![feed.version isEqual:version];
        feed.dev = dev;
        feed.version = version;
        if (!controller) {
            controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:NO updaterDelegate:feed userDriverDelegate:nil];
            NSError *error = nil;
            if (![controller.updater startUpdater:&error]) {
                controller = nil;
                napi_throw_error(env, NULL, "Sparkle could not start. The GitHub download is available.");
                return NULL;
            }
        }
        controller.updater.automaticallyChecksForUpdates = automatic;
        controller.updater.automaticallyDownloadsUpdates = automatic;
        if (changed) [controller.updater resetUpdateCycleAfterShortDelay];
    } @catch (NSException *exception) {
        napi_throw_error(env, NULL, "Sparkle could not configure updates.");
        return NULL;
    }
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

static napi_value Install(napi_env env, napi_callback_info info) {
    if (!controller || !NSThread.isMainThread) {
        napi_throw_error(env, NULL, "The Mac updater is unavailable.");
        return NULL;
    }
    @try { [controller checkForUpdates:nil]; }
    @catch (NSException *exception) {
        napi_throw_error(env, NULL, "Sparkle could not start the installation.");
        return NULL;
    }
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

NAPI_MODULE_INIT() {
    const napi_property_descriptor methods[] = {
        {"configure", NULL, Configure, NULL, NULL, NULL, napi_default, NULL},
        {"install", NULL, Install, NULL, NULL, NULL, napi_default, NULL},
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
    return exports;
}
