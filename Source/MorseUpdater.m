// Electron's main thread owns AppKit and this controller for the life of Morse.
#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>

static SPUStandardUpdaterController *controller;

static napi_value Configure(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value arg;
    bool automatic = false;
    napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
    if (argc != 1 || napi_get_value_bool(env, arg, &automatic) != napi_ok || !NSThread.isMainThread) {
        napi_throw_type_error(env, NULL, "Configure the updater on the Mac main thread with a boolean.");
        return NULL;
    }
    @try {
        if (!controller) {
            controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:NO updaterDelegate:nil userDriverDelegate:nil];
            NSError *error = nil;
            if (![controller.updater startUpdater:&error]) {
                controller = nil;
                napi_throw_error(env, NULL, "Sparkle could not start. The GitHub download is available.");
                return NULL;
            }
        }
        controller.updater.automaticallyChecksForUpdates = automatic;
        controller.updater.automaticallyDownloadsUpdates = automatic;
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
