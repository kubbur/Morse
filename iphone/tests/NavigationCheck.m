// Linked only into the simulator test app. Check UIKit hit testing as well as the HTML target.
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

static void finish(NSString *message, NSTimer *timer) {
    [timer invalidate];
    [message writeToFile:[NSTemporaryDirectory() stringByAppendingPathComponent:@"navigation-check.txt"]
              atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

@interface NavigationCheck : NSObject @end
@implementation NavigationCheck
+ (void)load {
    dispatch_async(dispatch_get_main_queue(), ^{
        __block NSUInteger step = 0;
        __block BOOL pending = NO;
        __block BOOL switchProbeChecked = NO;
        [NSTimer scheduledTimerWithTimeInterval:.25 repeats:YES block:^(NSTimer *timer) {
            if (pending) return;
            UIWindow *window = nil;
            for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
                if ([scene isKindOfClass:UIWindowScene.class])
                    for (UIWindow *candidate in ((UIWindowScene *)scene).windows) if (candidate.isKeyWindow) window = candidate;
            UINavigationController *nav = (id)window.rootViewController;
            if (![nav isKindOfClass:UINavigationController.class]) return;
            UIViewController *trainer = nav.topViewController;
            if (!trainer) return;
            WKWebView *web = nil;
            for (UIView *child in [@[trainer.view] arrayByAddingObjectsFromArray:trainer.view.subviews])
                if ([child isKindOfClass:WKWebView.class]) web = (id)child;
            if (!web || web.loading || ![web.URL.lastPathComponent isEqual:(step == 0 ? @"probe.html" : @"index.html")]) return;
            CGRect content = [web convertRect:web.bounds toView:window];
            CGRect bar = [nav.navigationBar convertRect:nav.navigationBar.bounds toView:window];
            if (CGRectGetMinY(content) + .5 < CGRectGetMaxY(bar)) {
                finish([NSString stringWithFormat:@"FAIL web top %.1f, navigation bar bottom %.1f",CGRectGetMinY(content),CGRectGetMaxY(bar)],timer);
                return;
            }
            if (step == 0 && !switchProbeChecked) {
                pending = YES;
                NSString *test = @"const start=document.getElementById('switch-start');"
                    "if(typeof start?.onclick!=='function') return 'loading';"
                    "await start.onclick(); const post=globalThis.morsePhone.post;"
                    "const initial=await post({op:'snapshot'});"
                    "if(initial.testMode!=='airpods-switch'||!initial.switchTest?.current) return 'missing switch probe';"
                    "const stop=document.getElementById('switch-stop');"
                    "for(let i=0;stop.disabled&&i<30;i++) await new Promise(r=>setTimeout(r,100));"
                    "if(stop.disabled)return 'stop unavailable';await stop.onclick();"
                    "const stopped=await post({op:'snapshot'});"
                    "const again=await post({op:'snapshot'});"
                    "return stopped.switchTest?.finished==='Stopped by tester'&&"
                    "stopped.switchTest.current.time===again.switchTest.current.time?'ok':'missing retained report';";
                [web callAsyncJavaScript:test arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
                    completionHandler:^(id value, NSError *error) {
                        pending = NO;
                        if ([value isEqual:@"loading"]) return;
                        if (!error && [value isEqual:@"ok"]) switchProbeChecked = YES;
                        else finish([NSString stringWithFormat:@"FAIL switch probe: %@",error.localizedDescription ?: value],timer);
                    }];
                return;
            }
            if (step == 2) {
                pending = YES;
                [web evaluateJavaScript:@"!document.getElementById('view-send').hidden" completionHandler:^(id result, NSError *error) {
                    pending = NO;
                    if ([result isEqual:@YES]) finish(@"PASS switch probe starts and retains its stopped report; paddle test and Send tab receive hits.",timer);
                }];
                return;
            }
            NSString *selector = step == 0 ? @"h1" : @"button[data-view=send]";
            NSString *script = [NSString stringWithFormat:
                @"(()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());"
                 "const e=document.querySelector('%@');if(!e)return null;const r=e.getBoundingClientRect();"
                 "const x=r.x+r.width/2,y=r.y+r.height/2;return [x,y,innerWidth,r.top,e.contains(document.elementFromPoint(x,y))]})()",selector];
            pending = YES;
            [web evaluateJavaScript:script completionHandler:^(NSArray *point, NSError *error) {
                pending = NO;
                if (![point isKindOfClass:NSArray.class] || point.count != 5) return;
                CGFloat scale = web.bounds.size.width / [point[2] doubleValue];
                CGPoint p = [web convertPoint:CGPointMake([point[0] doubleValue]*scale,[point[1] doubleValue]*scale) toView:window];
                UIView *hit = [window hitTest:p withEvent:nil];
                if ([point[3] doubleValue] < 0 || ![point[4] boolValue] || (hit != web && ![hit isDescendantOfView:web])) {
                    finish([NSString stringWithFormat:@"FAIL %@ is covered",selector],timer); return;
                }
                if (step++ == 0) {
                    UIBarButtonItem *trainerButton = trainer.navigationItem.rightBarButtonItem;
                    [UIApplication.sharedApplication sendAction:trainerButton.action to:trainerButton.target from:trainerButton forEvent:nil];
                } else [web evaluateJavaScript:@"document.querySelector('button[data-view=send]').click()" completionHandler:nil];
            }];
        }];
    });
}
@end
