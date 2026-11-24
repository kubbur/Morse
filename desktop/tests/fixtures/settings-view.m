// Load the bundled trainer in an offscreen WebKit DOM. All HTTP requests in
// this test process are served from the fixture directory or answered locally.
#import <WebKit/WebKit.h>
static NSString *directory, *origin;
@interface FixtureProtocol : NSURLProtocol @end
@implementation FixtureProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
    return [@[@"https", @"http"] containsObject:request.URL.scheme];
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
    NSURL *url=self.request.URL;
    NSString *file=[[directory stringByAppendingPathComponent:url.path] stringByStandardizingPath];
    NSData *data=nil;
    if ([url.host isEqual:origin] && [file hasPrefix:[directory stringByAppendingString:@"/"]])
        data=[NSData dataWithContentsOfFile:file];
    NSDictionary *types=@{@"mjs":@"text/javascript", @"js":@"text/javascript", @"css":@"text/css",
                          @"woff2":@"font/woff2", @"svg":@"image/svg+xml", @"png":@"image/png"};
    NSHTTPURLResponse *response=[[NSHTTPURLResponse alloc] initWithURL:url statusCode:data ? 200 : 404
        HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type":types[file.pathExtension] ?: @"text/plain", @"Cache-Control":@"no-store"}];
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (data) [self.client URLProtocol:self didLoadData:data];
    [self.client URLProtocolDidFinishLoading:self];
}
- (void)stopLoading {}
@end

int main(int argc,const char **argv) { @autoreleasepool {
    if (argc!=4) return 2;
    directory=[@(argv[1]) stringByStandardizingPath];
    origin=[NSUUID.UUID.UUIDString.lowercaseString stringByAppendingString:@".invalid"];
    [NSURLProtocol registerClass:FixtureProtocol.class];
    NSString *html=[NSString stringWithContentsOfFile:[directory stringByAppendingPathComponent:@"index.html"] encoding:NSUTF8StringEncoding error:nil];
    NSString *bootstrap=[NSString stringWithContentsOfFile:@(argv[2]) encoding:NSUTF8StringEncoding error:nil];
    NSString *scenario=[NSString stringWithContentsOfFile:@(argv[3]) encoding:NSUTF8StringEncoding error:nil];
    if (!html || !bootstrap || !scenario) return 2;
    html=[html stringByReplacingOccurrencesOfString:@"<head>" withString:
        [NSString stringWithFormat:@"<head><script>%@</script>",bootstrap]];
    WebView *web=[[WebView alloc] initWithFrame:NSMakeRect(0,0,1080,820) frameName:nil groupName:origin];
    WebPreferences *prefs=[[WebPreferences alloc] initWithIdentifier:origin];
    prefs.autosaves=NO; prefs.privateBrowsingEnabled=YES; web.preferences=prefs;
    [web setMaintainsBackForwardList:NO];
    [[web mainFrame] loadHTMLString:html baseURL:[NSURL URLWithString:[NSString stringWithFormat:@"https://%@/fixture",origin]]];
    NSDate *limit=[NSDate dateWithTimeIntervalSinceNow:12]; BOOL started=NO;
    while (limit.timeIntervalSinceNow>0) {
        @autoreleasepool {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
            NSString *error=[web stringByEvaluatingJavaScriptFromString:@"window.testFailure || ''"];
            if (error.length) { fprintf(stderr,"%s\n",error.UTF8String); return 1; }
            if (!started && [[web stringByEvaluatingJavaScriptFromString:@"document.querySelectorAll('#stats-grid article').length > 0"] isEqual:@"true"]) {
                started=YES;
                [web stringByEvaluatingJavaScriptFromString:scenario];
            }
            if ([[web stringByEvaluatingJavaScriptFromString:@"window.testComplete === true"] isEqual:@"true"]) return 0;
        }
    }
    fprintf(stderr,"WebKit fixture timed out %s loading the trainer.\n",started ? "after" : "before"); return 1;
} }
