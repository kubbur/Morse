#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import "PaddleAudio.h"
#import "Website.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>

// WKWebView gets a real loopback origin for ES modules, workers, Web Locks and Web
// Crypto. HTTP serves only immutable bundled files. Native calls stay inside WebKit.
@interface TrainerServer : NSObject
@property(nonatomic,readonly) unsigned port;
@end
static void sendAll(int fd, NSData *data) {
    const char *p=data.bytes; size_t remaining=data.length;
    while (remaining) {
        ssize_t n=send(fd,p,remaining,0);
        if (n<0 && errno==EINTR) continue;
        if (n<=0) break;
        p+=n; remaining-=n;
    }
}
static void serve(int fd, NSURL *root, unsigned port) {
    @autoreleasepool {
        int yes=1; struct timeval timeout={2,0};
        setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes));
        setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
        setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
        fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)&~O_NONBLOCK);
        char buffer[8193]; size_t count=0;
        while (count<sizeof(buffer)-1) {
            ssize_t n=recv(fd,buffer+count,sizeof(buffer)-1-count,0);
            if (n<=0) break;
            count+=n; buffer[count]=0;
            if (strstr(buffer,"\r\n\r\n")) break;
        }
        NSString *headers=[[NSString alloc] initWithBytes:buffer length:count encoding:NSUTF8StringEncoding];
        NSArray *lines=[headers componentsSeparatedByString:@"\r\n"];
        NSArray *first=[lines.firstObject componentsSeparatedByString:@" "];
        NSString *host=[NSString stringWithFormat:@"host: 127.0.0.1:%u",port];
        BOOL trusted=NO;
        for (NSString *line in lines) if ([line.lowercaseString isEqual:host]) trusted=YES;
        NSData *data=nil; NSString *type=@"text/plain"; BOOL head=[first.firstObject isEqual:@"HEAD"];
        if (trusted && first.count==3 && (head || [first.firstObject isEqual:@"GET"])) {
            NSString *path=[[[first[1] componentsSeparatedByString:@"?"] firstObject] stringByRemovingPercentEncoding];
            if ([path isEqual:@"/"]) path=@"/index.html";
            if ([path hasPrefix:@"/"] && ![path.pathComponents containsObject:@".."] && ![path containsString:@"\\"]) {
                NSURL *file=[root URLByAppendingPathComponent:[path substringFromIndex:1]];
                NSDictionary *types=@{@"html":@"text/html; charset=utf-8",@"js":@"text/javascript",@"mjs":@"text/javascript",
                    @"css":@"text/css",@"svg":@"image/svg+xml",@"json":@"application/json",@"png":@"image/png",
                    @"woff2":@"font/woff2",@"wav":@"audio/wav"};
                type=types[file.pathExtension.lowercaseString] ?: @"application/octet-stream";
                data=[NSData dataWithContentsOfURL:file options:NSDataReadingMappedIfSafe error:nil];
            }
        }
        NSString *header=[NSString stringWithFormat:@"HTTP/1.1 %@\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: %@\r\nContent-Length: %lu\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'\r\n\r\n",data?@"200 OK":@"404 Not Found",type,(unsigned long)data.length];
        sendAll(fd,[header dataUsingEncoding:NSUTF8StringEncoding]);
        if (!head && data) sendAll(fd,data);
        close(fd);
    }
}
@implementation TrainerServer {
    dispatch_source_t _listener;
}
- (instancetype)init {
    if (!(self=[super init])) return nil;
    int fd=socket(AF_INET,SOCK_STREAM,0);
    if (fd<0) return nil;
    int yes=1; setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof(yes));
    struct sockaddr_in address={.sin_len=sizeof(address),.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    unsigned previous=(unsigned)[NSUserDefaults.standardUserDefaults integerForKey:@"trainer-port"];
    address.sin_port=htons(previous);
    if (bind(fd,(struct sockaddr *)&address,sizeof(address))<0) {
        address.sin_port=0;
        if (!previous || bind(fd,(struct sockaddr *)&address,sizeof(address))<0) { close(fd); return nil; }
    }
    socklen_t len=sizeof(address);
    if (getsockname(fd,(struct sockaddr *)&address,&len)<0 || listen(fd,20)<0) { close(fd); return nil; }
    _port=ntohs(address.sin_port);
    [NSUserDefaults.standardUserDefaults setInteger:_port forKey:@"trainer-port"];
    fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)|O_NONBLOCK);
    dispatch_queue_t queue=dispatch_queue_create("digital.kubbur.morse.http",DISPATCH_QUEUE_SERIAL);
    _listener=dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,fd,0,queue);
    NSURL *root=[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Trainer"];
    unsigned port=_port;
    dispatch_source_set_event_handler(_listener,^{
        int client;
        while ((client=accept(fd,NULL,NULL))>=0) {
            int socketFD=client;
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{ serve(socketFD,root,port); });
        }
    });
    dispatch_source_set_cancel_handler(_listener,^{ close(fd); });
    dispatch_resume(_listener);
    return self;
}
- (void)dealloc { if (_listener) dispatch_source_cancel(_listener); }
@end

@interface Trainer : UIViewController <WKNavigationDelegate,WKUIDelegate,WKScriptMessageHandlerWithReply>
@property(nonatomic,strong) PaddleAudio *audio;
@end
@implementation Trainer {
    TrainerServer *_server; WKWebView *_web; Website *_website;
    NSURL *_save; NSDictionary *_record; BOOL _saveError;
}
- (NSURL *)url:(NSString *)path {
    return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%u/%@",_server.port,path]];
}
- (BOOL)local:(NSURL *)url {
    return [url.scheme isEqual:@"http"] && [url.host isEqual:@"127.0.0.1"] && url.port.unsignedIntValue==_server.port;
}
- (void)viewDidLoad {
    [super viewDidLoad]; self.title=@"Morse"; _server=[TrainerServer new];
    if (!_server) { UILabel *notice=[UILabel new]; notice.text=@"Could not open the offline trainer."; self.view=notice; return; }
    _audio=[PaddleAudio new]; _website=[Website new];
    NSError *error=nil;
    NSURL *folder=[NSFileManager.defaultManager URLForDirectory:NSApplicationSupportDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:&error];
    _save=[folder URLByAppendingPathComponent:@"learner.json"]; _saveError=(_save==nil);
    if (_save && [NSFileManager.defaultManager fileExistsAtPath:_save.path]) {
        NSData *data=[NSData dataWithContentsOfURL:_save]; id value=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;
        if ([value isKindOfClass:NSDictionary.class] && [value[@"raw"] isKindOfClass:NSString.class] && [value[@"revision"] isKindOfClass:NSNumber.class]) _record=value;
        else _saveError=YES;
    }
    WKWebViewConfiguration *config=[WKWebViewConfiguration new];
    config.mediaTypesRequiringUserActionForPlayback=WKAudiovisualMediaTypeNone;
    NSString *js=[NSString stringWithContentsOfURL:[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Trainer/phone.js"] encoding:NSUTF8StringEncoding error:nil];
    [config.userContentController addUserScript:[[WKUserScript alloc] initWithSource:js injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    [config.userContentController addScriptMessageHandlerWithReply:self contentWorld:WKContentWorld.pageWorld name:@"morse"];
    _web=[[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
    _web.navigationDelegate=self; _web.UIDelegate=self;
    self.view.backgroundColor=UIColor.systemBackgroundColor;
    _web.translatesAutoresizingMaskIntoConstraints=NO;
    _web.scrollView.contentInsetAdjustmentBehavior=UIScrollViewContentInsetAdjustmentNever;
    [self.view addSubview:_web];
    UILayoutGuide *safe=self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [_web.topAnchor constraintEqualToAnchor:safe.topAnchor],
        [_web.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor],
        [_web.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor],
        [_web.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor]
    ]];
    __weak Trainer *weak=self;
    _audio.publish=^(NSArray *rows) {
        Trainer *trainer=weak;
        if (!trainer) return;
        [trainer->_web callAsyncJavaScript:@"window.morsePhoneEvents?.(rows)" arguments:@{@"rows":rows}
                 inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:nil];
    };
    self.navigationItem.rightBarButtonItem=[[UIBarButtonItem alloc] initWithTitle:@"Trainer" style:UIBarButtonItemStylePlain target:self action:@selector(toggle)];
    [_web loadRequest:[NSURLRequest requestWithURL:[self url:@"probe.html"]]];
}
- (void)toggle {
    BOOL probe=[_web.URL.path isEqual:@"/probe.html"];
    [_web loadRequest:[NSURLRequest requestWithURL:[self url:probe?@"index.html":@"probe.html"]]];
}
- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decision {
    NSURL *url=action.request.URL;
    BOOL allowed=[self local:url] && action.targetFrame.isMainFrame;
    if (allowed && ![url.path isEqual:view.URL.path]) [_audio command:@"input" value:@"off"];
    decision(allowed?WKNavigationActionPolicyAllow:WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)n {
    self.navigationItem.rightBarButtonItem.title=[view.URL.path isEqual:@"/probe.html"]?@"Trainer":@"Paddle test";
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)view {
    [_audio command:@"input" value:@"off"]; [view reload];
}
- (void)webView:(WKWebView *)view runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt defaultText:(NSString *)text
                initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSString *))done {
    if (!frame.isMainFrame || ![self local:frame.request.URL] || ![prompt isEqual:@"morse-learner"]) { done(nil); return; }
    NSData *body=[text dataUsingEncoding:NSUTF8StringEncoding];
    id args=body?[NSJSONSerialization JSONObjectWithData:body options:0 error:nil]:nil;
    NSDictionary *result=@{@"error":@"Could not read or save the learner file."};
    if (!_saveError && [args isKindOfClass:NSDictionary.class]) {
        if ([args[@"op"] isEqual:@"load"]) result=_record ?: @{@"revision":@0,@"raw":args[@"old"] ?: NSNull.null};
        else if ([args[@"op"] isEqual:@"save"] && [args[@"raw"] isKindOfClass:NSString.class] &&
                 [args[@"revision"] isKindOfClass:NSNumber.class] && [args[@"revision"] integerValue]==[_record[@"revision"] integerValue]) {
            NSDictionary *next=@{@"raw":args[@"raw"],@"revision":@([_record[@"revision"] integerValue]+1)};
            NSData *bytes=[NSJSONSerialization dataWithJSONObject:next options:0 error:nil];
            if (bytes && [bytes writeToURL:_save options:NSDataWritingAtomic|NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:nil]) {
                _record=next; result=@{@"revision":next[@"revision"]};
            }
        }
    }
    done([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:result options:0 error:nil] encoding:NSUTF8StringEncoding]);
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id,NSString *))reply {
    if (!message.frameInfo.isMainFrame || ![self local:message.frameInfo.request.URL] || ![message.body isKindOfClass:NSDictionary.class]) {
        reply(nil,@"Invalid trainer origin."); return;
    }
    NSDictionary *body=message.body; NSString *op=body[@"op"];
    if ([op isEqual:@"paddle"]) reply([_audio command:body[@"name"] value:body[@"value"]],nil);
    else if ([op isEqual:@"snapshot"]) reply([_audio snapshot],nil);
    else if ([op isEqual:@"exchange"]) [_website exchange:body[@"action"] payload:body[@"payload"] reply:^(NSDictionary *r){ reply(r,nil); }];
    else if ([op isEqual:@"prompt"]) [_audio play:body reply:^(NSDictionary *r){ reply(r,nil); }];
    else if ([op isEqual:@"stopPrompt"]) { [_audio stopPrompt:body[@"id"]]; reply(@{},nil); }
    else if ([op isEqual:@"copy"] && [body[@"text"] isKindOfClass:NSString.class] && [body[@"text"] length]<16000) {
        UIPasteboard.generalPasteboard.string=body[@"text"]; reply(@{},nil);
    } else reply(nil,@"Unknown trainer request.");
}
@end
@interface MorseScene : UIResponder <UIWindowSceneDelegate>
@property(nonatomic,strong) UIWindow *window;
@property(nonatomic,strong) Trainer *trainer;
@end
@implementation MorseScene
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    self.window=[[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene]; self.trainer=[Trainer new];
    self.window.rootViewController=[[UINavigationController alloc] initWithRootViewController:self.trainer];
    [self.window makeKeyAndVisible];
}
- (void)sceneDidEnterBackground:(UIScene *)scene { [self.trainer.audio suspend]; }
- (void)sceneDidBecomeActive:(UIScene *)scene { [self.trainer.audio resume]; }
- (void)sceneDidDisconnect:(UIScene *)scene { [self.trainer.audio suspend]; }
@end
@interface MorseApp : UIResponder <UIApplicationDelegate> @end
@implementation MorseApp @end
int main(int argc, char **argv) {
    @autoreleasepool { return UIApplicationMain(argc,argv,nil,NSStringFromClass(MorseApp.class)); }
}
