#import "Website.h"
#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>

static NSString *const origin = @"https://morse.kubbur.digital";
typedef void (^Result)(NSDictionary *);
typedef void (^Response)(NSInteger,NSDictionary *,NSHTTPURLResponse *);

static NSDictionary *failure(NSInteger code, NSString *why) {
    return @{@"status":@(code),@"error":why};
}
static BOOL matches(NSString *s, NSString *regex) {
    return [s isKindOfClass:NSString.class] && [s rangeOfString:regex options:NSRegularExpressionSearch].location != NSNotFound;
}
static NSString *cookieName(NSString *kind, NSString *scope) {
    NSData *bytes=[scope dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char hash[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(bytes.bytes,(CC_LONG)bytes.length,hash);
    NSMutableString *key=[NSMutableString stringWithFormat:@"morse_%@_",kind];
    for (int i=0;i<16;i++) [key appendFormat:@"%02x",hash[i]];
    return key;
}
static NSMutableDictionary *query(NSString *name) {
    return [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
              (__bridge id)kSecAttrService:@"digital.kubbur.morse.iphone.website",
              (__bridge id)kSecAttrAccount:name} mutableCopy];
}
static OSStatus readToken(NSString *name, NSString **value) {
    NSMutableDictionary *q=query(name); q[(__bridge id)kSecReturnData]=@YES;
    CFTypeRef data=NULL;
    OSStatus status=SecItemCopyMatching((__bridge CFDictionaryRef)q,&data);
    if (status==errSecItemNotFound) return errSecSuccess;
    if (!status) *value=[[NSString alloc] initWithData:CFBridgingRelease(data) encoding:NSUTF8StringEncoding];
    return status;
}
static OSStatus writeToken(NSString *name, NSString *value) {
    NSMutableDictionary *q=query(name);
    if (!value.length) {
        OSStatus status=SecItemDelete((__bridge CFDictionaryRef)q);
        return status==errSecItemNotFound ? errSecSuccess : status;
    }
    NSDictionary *values=@{(__bridge id)kSecValueData:[value dataUsingEncoding:NSUTF8StringEncoding],
                           (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly};
    OSStatus status=SecItemUpdate((__bridge CFDictionaryRef)q,(__bridge CFDictionaryRef)values);
    if (status==errSecItemNotFound) { [q addEntriesFromDictionary:values]; status=SecItemAdd((__bridge CFDictionaryRef)q,NULL); }
    return status;
}
@interface Website () <NSURLSessionTaskDelegate>
@end
@implementation Website {
    NSURLSession *_network;
    NSDictionary *_capabilities;
    NSDate *_expires;
    NSMutableArray *_waiting;
    NSSet *_actions;
}
- (instancetype)init {
    if ((self=[super init])) {
        NSURLSessionConfiguration *config=[NSURLSessionConfiguration ephemeralSessionConfiguration];
        config.HTTPCookieStorage=nil; config.HTTPShouldSetCookies=NO; config.URLCredentialStorage=nil;
        config.URLCache=nil; config.timeoutIntervalForRequest=8; config.timeoutIntervalForResource=15;
        _network=[NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:NSOperationQueue.mainQueue];
        _actions=[NSSet setWithArray:[@"private/status private/start private/join private/approve private/cancel private/push private/disconnect private/recovery-code private/recover private/adopt scores/session scores/consent scores/prepare scores/submit scores/leaderboard scores/history scores/history-preview" componentsSeparatedByString:@" "]];
    }
    return self;
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
        willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
                 completionHandler:(void (^)(NSURLRequest *))done { done(nil); }
- (void)request:(NSString *)path version:(NSInteger)v body:(NSDictionary *)body cookie:(NSString *)cookie completion:(Response)complete {
    NSMutableURLRequest *request=[NSMutableURLRequest requestWithURL:[NSURL URLWithString:[origin stringByAppendingString:path]]];
    request.HTTPShouldHandleCookies=NO;
    [request setValue:origin forHTTPHeaderField:@"Origin"];
    if (body) {
        request.HTTPMethod=@"POST";
        [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
        [request setValue:[@(v) stringValue] forHTTPHeaderField:@"X-Morse-Sync"];
        request.HTTPBody=[NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
        if (!request.HTTPBody) { complete(400,@{},nil); return; }
    }
    if (cookie.length) [request setValue:cookie forHTTPHeaderField:@"Cookie"];
    [[_network dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *r, NSError *error) {
        NSHTTPURLResponse *http=[r isKindOfClass:NSHTTPURLResponse.class]?(NSHTTPURLResponse *)r:nil;
        NSInteger status=http.statusCode;
        id info=(data.length && data.length<=8000000) ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;
        if (error || !status) status=503;
        if (status>=200 && status<300 && ![info isKindOfClass:NSDictionary.class]) status=502;
        complete(status,[info isKindOfClass:NSDictionary.class]?info:@{},http);
    }] resume];
}
- (void)capabilities:(Result)reply {
    if (_capabilities && [_expires timeIntervalSinceNow]>0) { reply(_capabilities); return; }
    if (_waiting) { [_waiting addObject:[reply copy]]; return; }
    _waiting=[NSMutableArray arrayWithObject:[reply copy]];
    [self request:@"/api/v2/capabilities" version:2 body:nil cookie:nil completion:^(NSInteger code, NSDictionary *data, NSHTTPURLResponse *r) {
        BOOL v2=code==200 && [data[@"application"] isEqual:@"morse"] && [data[@"protocol"] isEqual:@2] &&
            [data[@"privateSync"] isEqual:@YES] && [data[@"scores"] isEqual:@YES];
        NSDictionary *caps=failure(503,@"Website unavailable. Practice is saved on this iPhone.");
        if (code==404 || code==200) {
            caps=@{@"status":@200,@"privateSync":@(v2),@"scores":@(v2),@"leaderboard":@YES};
            self->_capabilities=caps; self->_expires=[NSDate dateWithTimeIntervalSinceNow:60];
        }
        NSArray *callbacks=self->_waiting; self->_waiting=nil;
        for (Result block in callbacks) block(caps);
    }];
}
- (void)exchange:(NSString *)action payload:(NSDictionary *)payload reply:(Result)reply {
    if ([action isEqual:@"capabilities"]) { [self capabilities:reply]; return; }
    if (![_actions containsObject:action]) { reply(failure(400,@"Unknown website operation.")); return; }
    [self capabilities:^(NSDictionary *caps) {
        if (![caps[@"status"] isEqual:@200]) { reply(caps); return; }
        BOOL v2=[caps[@"scores"] boolValue];
        BOOL board=[action isEqual:@"scores/leaderboard"];
        if (!v2 && !board) { reply(failure(503,@"This website supports rankings only. Progress is saved here.")); return; }
        NSString *scope=board?@"public":payload[@"scope"];
        NSDictionary *body=board ? @{} : payload[@"body"];
        if (!matches(scope,@"\\A[A-Za-z0-9_-]{1,80}\\z") || ![body isKindOfClass:NSDictionary.class]) {
            reply(failure(400,@"Invalid learner request.")); return;
        }
        NSString *kind=[[action componentsSeparatedByString:@"/"] firstObject], *name=cookieName(kind,scope);
        NSMutableArray *cookies=[NSMutableArray array];
        if (!board) {
            NSArray *keys=[action isEqual:@"scores/consent"] ? @[name,cookieName(@"private",scope)] : @[name];
            for (NSString *key in keys) {
                NSString *token=nil;
                if (readToken(key,&token)!=errSecSuccess || (token && !matches(token,@"\\A[A-Za-z0-9_-]{43}\\z"))) {
                    reply(failure(503,@"Device credentials are unavailable.")); return;
                }
                if (token) [cookies addObject:[NSString stringWithFormat:@"%@=%@",key,token]];
            }
        }
        [self request:v2?[@"/api/v2/" stringByAppendingString:action]:@"/api/sync/leaderboard" version:v2?2:1
            body:v2?@{@"scope":scope,@"body":body}:@{} cookie:[cookies componentsJoinedByString:@"; "]
            completion:^(NSInteger code, NSDictionary *data, NSHTTPURLResponse *r) {
                if (code<200 || code>=300) {
                    NSString *message=[data[@"error"] isKindOfClass:NSString.class]?data[@"error"]:@"Could not reach the Morse website.";
                    reply(failure(code,message)); return;
                }
                if (board) {
                    NSArray *rows=data[@"entries"]; NSMutableArray *public=[NSMutableArray array];
                    if (![rows isKindOfClass:NSArray.class] || rows.count>50) { reply(failure(502,@"Invalid rankings.")); return; }
                    for (NSDictionary *row in rows) {
                        if (![row isKindOfClass:NSDictionary.class] || !matches(row[@"callsign"],@"\\A[A-Z0-9/]{2,16}\\z") ||
                            ![row[@"rank"] isKindOfClass:NSNumber.class] || ![row[@"xp"] isKindOfClass:NSNumber.class] ||
                            ![row[@"streak"] isKindOfClass:NSNumber.class]) { reply(failure(502,@"Invalid rankings.")); return; }
                        [public addObject:[row dictionaryWithValuesForKeys:@[@"rank",@"callsign",@"xp",@"streak"]]];
                    }
                    reply(@{@"status":@200,@"entries":public,@"me":NSNull.null}); return;
                }
                NSString *cookie=[r valueForHTTPHeaderField:@"Set-Cookie"];
                if (cookie) {
                    NSString *first=[cookie componentsSeparatedByString:@";"].firstObject;
                    NSString *prefix=[name stringByAppendingString:@"="];
                    if (![first hasPrefix:prefix]) { reply(failure(502,@"Unexpected website credential.")); return; }
                    NSString *value=[first substringFromIndex:prefix.length];
                    if ((value.length && !matches(value,@"\\A[A-Za-z0-9_-]{43}\\z")) || writeToken(name,value)!=errSecSuccess) {
                        reply(failure(503,@"Could not save the device credential.")); return;
                    }
                }
                NSMutableDictionary *result=[data mutableCopy]; result[@"status"]=@(code); reply(result);
            }];
    }];
}
@end
