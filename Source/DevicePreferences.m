#import "DevicePreferences.h"

@implementation DevicePreferences {
    NSURL *_file;
    NSMutableDictionary *_values;
}
- (instancetype)initWithDirectory:(NSURL *)directory legacy:(NSDictionary *)legacy error:(NSError **)error {
    if (!(self=[super init])) return nil;
    NSFileManager *fm=NSFileManager.defaultManager;
    if (![fm createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:error]) return nil;
    _file=[directory URLByAppendingPathComponent:@"paddle-v1.plist"];
    if ([fm fileExistsAtPath:_file.path]) {
        _values=[[NSDictionary dictionaryWithContentsOfURL:_file error:error] mutableCopy];
        if (!_values || ![_values[@"schema"] isEqual:@1]) return nil;
        NSURL *beforeSound=[directory URLByAppendingPathComponent:@"paddle-before-shared-sound.plist"];
        if (![_values[@"sharedSound"] boolValue] && (_values[@"sidetoneSettings"] || _values[@"sidetoneVolume"]) &&
            ![fm fileExistsAtPath:beforeSound.path] && ![fm copyItemAtURL:_file toURL:beforeSound error:error]) return nil;
        return self;
    }
    NSURL *backup=[directory URLByAppendingPathComponent:@"paddle-before-merge.plist"];
    if (legacy.count && ![fm fileExistsAtPath:backup.path] && ![legacy writeToURL:backup error:error]) return nil;
    if ([fm fileExistsAtPath:backup.path]) {
        legacy=[NSDictionary dictionaryWithContentsOfURL:backup error:error];
        if (!legacy) return nil;
    }
    _values=[@{@"schema":@1} mutableCopy];
    for (NSString *key in @[@"wiredPaddleInputProfile",@"sidetoneSettings",@"sidetoneVolume",@"sidetoneOutput",@"sidetoneName",@"paddlesSwapped"]) {
        if (legacy[key]) _values[key]=legacy[key];
    }
    id tone=legacy[@"sidetoneSettings"];
    id wpm=[tone isKindOfClass:NSDictionary.class] ? tone[@"wpm"] : nil;
    if ([wpm isKindOfClass:NSNumber.class] && [wpm integerValue]>=5 && [wpm integerValue]<=60) _values[@"legacyWpm"]=wpm;
    return [_values writeToURL:_file error:error] ? self : nil;
}
- (id)objectForKey:(NSString *)key { @synchronized(self) { return _values[key]; } }
- (NSDictionary *)dictionaryForKey:(NSString *)key { id v=[self objectForKey:key]; return [v isKindOfClass:NSDictionary.class] ? v : nil; }
- (BOOL)boolForKey:(NSString *)key { return [[self objectForKey:key] isEqual:@YES]; }
- (void)setObject:(id)value forKey:(NSString *)key {
    @synchronized(self) {
        NSMutableDictionary *next=[_values mutableCopy];
        if (value) next[key]=value; else [next removeObjectForKey:key];
        if (![_values isEqual:next]) {
            if (![next writeToURL:_file error:nil]) [NSException raise:@"PreferenceWriteFailure" format:@"Could not save paddle settings"];
            _values=next;
        }
    }
}
- (void)setBool:(BOOL)value forKey:(NSString *)key { [self setObject:@(value) forKey:key]; }
- (void)removeObjectForKey:(NSString *)key { [self setObject:nil forKey:key]; }
@end
