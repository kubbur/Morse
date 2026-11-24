#import "PaddleBridge.h"
#include "Sidetone.h"
#include "PaddleClock.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

static const int bridgePort=17373;
static const NSUInteger historyLimit=256;
static BOOL sendAll(int socketFD, NSData *data) {
    const char *p=data.bytes; NSUInteger remaining=data.length;
    while (remaining) {
        ssize_t n=send(socketFD,p,remaining,0);
        if (n<0 && errno==EINTR) continue;
        if (n<=0) return NO;
        remaining-=(NSUInteger)n; p+=n;
    }
    return YES;
}
static NSData *utf8(NSString *s) { return [s dataUsingEncoding:NSUTF8StringEncoding]; }
static NSDictionary *requestHeader(int fd) {
    NSMutableData *raw=[NSMutableData data]; char buffer[1024];
    NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:4];
    while (raw.length<8192 && deadline.timeIntervalSinceNow>0) {
        ssize_t n=recv(fd,buffer,sizeof(buffer),0);
        if (n<0 && errno==EINTR) continue;
        if (n<=0) return nil;
        [raw appendBytes:buffer length:(NSUInteger)n];
        NSRange end=[raw rangeOfData:utf8(@"\r\n\r\n") options:0 range:NSMakeRange(0,raw.length)];
        if (end.location==NSNotFound) continue;
        NSString *header=[[NSString alloc] initWithData:[raw subdataWithRange:NSMakeRange(0,end.location)]
                                               encoding:NSASCIIStringEncoding];
        NSArray<NSString *> *lines=[header componentsSeparatedByString:@"\r\n"];
        NSArray *request=[lines.firstObject componentsSeparatedByString:@" "];
        if (request.count!=3) return nil;
        NSMutableDictionary *fields=[NSMutableDictionary dictionary];
        for (NSUInteger i=1;i<lines.count;i++) {
            NSRange sep=[lines[i] rangeOfString:@":"];
            if (sep.location==NSNotFound) return nil;
            NSString *key=[[lines[i] substringToIndex:sep.location] lowercaseString];
            if (fields[key]) return nil;
            fields[key]=[[lines[i] substringFromIndex:NSMaxRange(sep)] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        }
        return @{@"method":request[0],@"path":request[1],@"headers":fields};
    }
    return nil;
}
static BOOL headers(int fd, NSString *status, NSString *mime, NSString *extra, NSInteger length) {
    NSString *size=length>=0 ? [NSString stringWithFormat:@"Content-Length: %ld\r\n",(long)length] : @"";
    NSString *header=[NSString stringWithFormat:
        @"HTTP/1.1 %@\r\nContent-Type: %@\r\nCache-Control: no-store\r\nConnection: close\r\n"
         "X-Content-Type-Options: nosniff\r\nReferrer-Policy: same-origin\r\n%@%@\r\n",status,mime,size,extra ?: @""];
    return sendAll(fd,utf8(header));
}
@implementation PaddleBridge {
    NSURL *_resources;
    NSCondition *_condition;
    NSMutableArray<NSDictionary *> *_history;
    dispatch_source_t _listener;
    NSString *_origin;
    NSString *_muteOwner;
    NSCountedSet<NSString *> *_streamOrigins;
    unsigned long long _sequence;
    NSUInteger _clients, _connections;
    unsigned _wpm, _effectiveWpm;
    uint16_t _port;
    NSString *_localHost, *_localOrigin;
    BOOL _stopped;
}
- (instancetype)initWithResources:(NSURL *)resources { return [self initWithResources:resources port:bridgePort]; }
- (instancetype)initWithResources:(NSURL *)resources port:(uint16_t)port {
    if ((self=[super init])) {
        _port=port; _streamOrigins=[NSCountedSet new];
        _resources=resources; _condition=[NSCondition new]; _history=[NSMutableArray array]; _wpm=_effectiveWpm=defaultToneSettings.wpm;
        [self publish:@"waiting" mask:0 timeMs:paddleTimeMs()];
    }
    return self;
}
- (NSURL *)localURL { return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%u/",_port]]; }
+ (NSString *)originForURL:(NSURL *)url {
    if (!url || url.user || url.password) return nil;
    NSString *scheme=url.scheme.lowercaseString,*host=url.host.lowercaseString;
    if (!host.length || [host rangeOfCharacterFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].location!=NSNotFound) return nil;
    BOOL local=[@[@"127.0.0.1",@"localhost",@"::1",@"[::1]"] containsObject:host];
    if (![scheme isEqual:@"https"] && !([scheme isEqual:@"http"] && local)) return nil;
    if (url.port && (url.port.intValue<1 || url.port.intValue>65535)) return nil;
    NSURLComponents *parts=[NSURLComponents new]; parts.scheme=scheme; parts.host=host;
    if (url.port && url.port.intValue!=([scheme isEqual:@"https"]?443:80)) parts.port=url.port;
    return parts.URL.absoluteString;
}
- (BOOL)originAllowedLocked:(NSString *)origin {
    return !origin || [origin isEqual:_localOrigin] || [origin isEqual:_origin];
}
- (void)setMuteOwnerLocked:(NSString *)owner {
    BOOL changed=(_muteOwner!=nil)!=(owner!=nil);
    _muteOwner=[owner copy];
    if (changed && self.sidetoneMuteChanged) self.sidetoneMuteChanged(owner!=nil);
}
- (void)allowOrigin:(NSString *)origin {
    [_condition lock];
    _origin=[origin copy];
    if (_muteOwner && ![self originAllowedLocked:_muteOwner]) [self setMuteOwnerLocked:nil];
    [_condition broadcast]; [_condition unlock];
}
- (void)unmuteSidetone {
    [_condition lock]; [self setMuteOwnerLocked:nil]; [_condition unlock];
}
- (void)appendLocked:(NSString *)phase mask:(unsigned)mask timeMs:(double)time {
    NSDictionary *state=@{@"v":@1,@"seq":@(++_sequence),@"status":phase,@"dit":@((BOOL)(mask&1)),
                          @"dah":@((BOOL)((mask>>1)&1)),@"timeMs":@(time),@"wpm":@(_wpm),@"effectiveWpm":@(_effectiveWpm)};
    [_history addObject:state];
    if (_history.count>historyLimit) [_history removeObjectAtIndex:0];
    [_condition broadcast];
}
- (void)publish:(NSString *)phase mask:(unsigned)mask timeMs:(double)time {
    [_condition lock]; [self appendLocked:phase mask:mask timeMs:time]; [_condition unlock];
}
- (void)setKeyerWPM:(unsigned)wpm effective:(unsigned)effective {
    [_condition lock];
    if ((_wpm!=wpm || _effectiveWpm!=effective) && wpm>=MinKeyerWPM && wpm<=MaxKeyerWPM &&
        effective>=MinKeyerWPM && effective<=wpm) {
        _wpm=wpm; _effectiveWpm=effective;
        NSDictionary *last=_history.lastObject;
        unsigned mask=[last[@"dit"] unsignedIntValue] | ([last[@"dah"] unsignedIntValue]<<1);
        [self appendLocked:last[@"status"] mask:mask timeMs:paddleTimeMs()];
    }
    [_condition unlock];
}
- (BOOL)start:(NSError **)error {
    __weak PaddleBridge *weak=self;
    int fd=socket(AF_INET,SOCK_STREAM,0);
    if (fd<0) {
        if (error) *error=[NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
        return NO;
    }
    int yes=1; setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof(yes));
    fcntl(fd,F_SETFD,FD_CLOEXEC); fcntl(fd,F_SETFL,O_NONBLOCK);
    struct sockaddr_in address={.sin_len=sizeof(address),.sin_family=AF_INET,.sin_port=htons(_port)};
    address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    socklen_t size=sizeof(address);
    if (bind(fd,(struct sockaddr *)&address,sizeof(address))<0 || getsockname(fd,(struct sockaddr *)&address,&size)<0 || listen(fd,12)<0) {
        int saved=errno; close(fd);
        if (error) *error=[NSError errorWithDomain:NSPOSIXErrorDomain code:saved userInfo:nil];
        return NO;
    }
    _port=ntohs(address.sin_port); _localHost=[NSString stringWithFormat:@"127.0.0.1:%u",_port];
    _localOrigin=[@"http://" stringByAppendingString:_localHost];
    _listener=dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,fd,0,dispatch_get_main_queue());
    dispatch_source_set_cancel_handler(_listener,^{close(fd);});
    dispatch_source_set_event_handler(_listener,^{[weak acceptOn:fd];});
    dispatch_resume(_listener); return YES;
}
- (void)acceptOn:(int)listening {
    for (;;) {
        int fd=accept(listening,NULL,NULL);
        if (fd<0) { if (errno==EINTR) continue; return; }
        [_condition lock];
        BOOL full=_stopped || _connections>=20;
        if (!full) ++_connections;
        [_condition unlock];
        if (full) { close(fd); continue; }
        fcntl(fd,F_SETFL,0); fcntl(fd,F_SETFD,FD_CLOEXEC);
        int yes=1;
        setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes));
        setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&yes,sizeof(yes));
        struct timeval timeout={.tv_sec=3};
        setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
        setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
            @autoreleasepool { [self serve:fd]; close(fd); }
            [self->_condition lock]; --self->_connections; [self->_condition unlock];
        });
    }
}
- (void)serve:(int)fd {
    NSDictionary *request=requestHeader(fd), *fields=request[@"headers"];
    NSString *method=request[@"method"], *path=request[@"path"], *origin=fields[@"origin"];
    if (![fields[@"host"] isEqual:_localHost]) { headers(fd,@"403 Forbidden",@"text/plain",nil,0); return; }
    BOOL mute=[path isEqual:@"/sidetone/mute"];
    BOOL control=mute || [path isEqual:@"/sidetone/unmute"];
    [_condition lock]; BOOL allowed=[self originAllowedLocked:origin]; [_condition unlock];
    if (!allowed || (control && !origin) || (!origin && [fields[@"sec-fetch-site"] isEqual:@"cross-site"] && [path isEqual:@"/events"])) {
        headers(fd,@"403 Forbidden",@"text/plain",nil,0); return;
    }
    NSString *cors=origin ? [NSString stringWithFormat:@"Access-Control-Allow-Origin: %@\r\nVary: Origin\r\n",origin] : @"";
    if (control) {
        if ([method isEqual:@"OPTIONS"]) {
            headers(fd,@"204 No Content",@"text/plain",[cors stringByAppendingString:
                @"Access-Control-Allow-Methods: PUT, OPTIONS\r\nAccess-Control-Allow-Private-Network: true\r\n"],0);
            return;
        }
        if (![method isEqual:@"PUT"]) {
            headers(fd,@"405 Method Not Allowed",@"text/plain",[cors stringByAppendingString:@"Allow: PUT, OPTIONS\r\n"],0); return;
        }
        if (fields[@"transfer-encoding"] || (fields[@"content-length"] && ![fields[@"content-length"] isEqual:@"0"])) {
            headers(fd,@"400 Bad Request",@"text/plain",cors,0); return;
        }
        [_condition lock];
        allowed=!_stopped && [self originAllowedLocked:origin];
        if (allowed) [self setMuteOwnerLocked:mute ? origin : nil];
        [_condition unlock];
        headers(fd,allowed ? @"204 No Content" : @"403 Forbidden",@"text/plain",allowed ? cors : nil,0);
        return;
    }
    if ([method isEqual:@"OPTIONS"] && [path isEqual:@"/events"]) {
        headers(fd,@"204 No Content",@"text/plain",[cors stringByAppendingString:
            @"Access-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: Last-Event-ID\r\nAccess-Control-Allow-Private-Network: true\r\n"],0); return;
    }
    if (![method isEqual:@"GET"]) { headers(fd,@"405 Method Not Allowed",@"text/plain",nil,0); return; }
    if ([path isEqual:@"/events"]) {
        if (headers(fd,@"200 OK",@"text/event-stream; charset=utf-8",cors,-1)) [self stream:fd origin:origin];
        return;
    }
    NSDictionary *files=@{@"/":@[@"index.html",@"text/html; charset=utf-8"],
        @"/morse-paddle.js":@[@"morse-paddle.js",@"text/javascript; charset=utf-8"],
        @"/demo.js":@[@"demo.js",@"text/javascript; charset=utf-8"], @"/style.css":@[@"style.css",@"text/css; charset=utf-8"]};
    NSArray *file=files[path];
    NSData *body=file ? [NSData dataWithContentsOfURL:[_resources URLByAppendingPathComponent:file[0]]] : nil;
    if (!body) { headers(fd,@"404 Not Found",@"text/plain",nil,0); return; }
    NSString *policy=[cors stringByAppendingString:@"Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'\r\n"];
    if (headers(fd,@"200 OK",file[1],policy,(NSInteger)body.length)) sendAll(fd,body);
}
- (void)countChangedLocked {
    NSUInteger n=_clients;
    dispatch_async(dispatch_get_main_queue(),^{if (self.clientCountChanged) self.clientCountChanged(n);});
}
- (void)stream:(int)fd origin:(NSString *)origin {
    NSString *streamOrigin=origin ?: _localOrigin;
    [_condition lock]; ++_clients; [_streamOrigins addObject:streamOrigin]; [self countChangedLocked];
    [_condition unlock];
    unsigned long long last=0;
    double lastSentMs=0;
    BOOL initial=YES;
    BOOL ok=sendAll(fd,utf8(@"retry: 800\n\n"));
    while (ok) @autoreleasepool {
        [_condition lock];
        if (!initial && !_stopped && [self originAllowedLocked:origin] && last==_sequence)
            [_condition waitUntilDate:[NSDate dateWithTimeIntervalSinceNow:1.5]];
        if (_stopped || ![self originAllowedLocked:origin]) { [_condition unlock]; break; }
        unsigned long long first=[_history.firstObject[@"seq"] unsignedLongLongValue];
        BOOL reset=!initial && last+1<first;
        BOOL snapshot=initial || reset;
        NSUInteger start=snapshot ? _history.count-1 : (NSUInteger)(last+1-first);
        NSArray *batch=[_history subarrayWithRange:NSMakeRange(start,_history.count-start)];
        // The receiver uses the first snapshot to align its clock. An idle
        // contact may have last changed minutes before this subscription.
        if (snapshot) lastSentMs=MAX(lastSentMs,paddleTimeMs());
        initial=NO;
        [_condition unlock];
        if (reset) ok=sendAll(fd,utf8(@"event: reset\ndata: {}\n\n"));
        if (!batch.count) ok=sendAll(fd,utf8(@"event: heartbeat\ndata: {}\n\n"));
        for (NSDictionary *event in batch) {
            if (!ok) break;
            NSDictionary *outgoing=event;
            double timestamp=[event[@"timeMs"] doubleValue];
            if (timestamp<lastSentMs) {
                // A contact captured before the snapshot can finish publishing
                // just after it. Keep this subscriber's timeline monotonic.
                NSMutableDictionary *copy=[event mutableCopy]; copy[@"timeMs"]=@(lastSentMs); outgoing=copy;
            } else lastSentMs=timestamp;
            NSData *json=[NSJSONSerialization dataWithJSONObject:outgoing options:0 error:NULL];
            NSString *data=[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
            ok=sendAll(fd,utf8([NSString stringWithFormat:@"id: %@\nevent: paddle\ndata: %@\n\n",event[@"seq"],data]));
            last=[event[@"seq"] unsignedLongLongValue];
        }
    }
    [_condition lock];
    [_streamOrigins removeObject:streamOrigin];
    if ([streamOrigin isEqual:_muteOwner] && ![_streamOrigins containsObject:streamOrigin]) [self setMuteOwnerLocked:nil];
    --_clients; [self countChangedLocked]; [_condition unlock];
}
- (void)stop {
    [_condition lock]; _stopped=YES; [self setMuteOwnerLocked:nil]; [_condition broadcast]; [_condition unlock];
    if (_listener) { dispatch_source_cancel(_listener); _listener=nil; }
}
@end
