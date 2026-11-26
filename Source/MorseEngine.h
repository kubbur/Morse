#import <Foundation/Foundation.h>
#import "Sidetone.h"
#import "ElementStream.h"

#include "PaddleCalibration.h"

typedef NS_ENUM(unsigned, PaddleInputMode) {
    PaddleInputAudio, PaddleInputVBand, PaddleInputOff
};

@interface MorseEngine : NSObject
@property (nonatomic) PaddleInputMode inputMode;
- (void)setVBandContacts:(unsigned)mask; // physical left/right Control, supplied on the main thread
@property (atomic, copy) NSString *outputChoice;   // auto, speakers or a Bluetooth device UID
@property (nonatomic) unsigned sidetoneVolume;    // 0–100; affects only this app's sidetone
@property (nonatomic) BOOL sidetoneMuted;         // Temporary, independent of the volume setting
@property (nonatomic) BOOL paddlesSwapped;
@property (nonatomic) ToneSettings toneSettings;
@property (copy) void (^stateChanged)(NSString *phase, NSString *detail, unsigned mask, double timeMs, BOOL swappedForPress);
@property (copy) void (^outputsChanged)(NSArray<NSDictionary *> *devices, NSString *playingThrough);
@property (copy) void (^inputCalibrationChanged)(PaddleCalibrationStep step, BOOL sampling, BOOL boosted);
@property (copy) void (^adapterConnectionChanged)(BOOL connected);
- (instancetype)initWithDefaults:(NSUserDefaults *)defaults;
- (unsigned)elementEpoch;
- (BOOL)takeElement:(ElementEvent *)event;
- (void)interruptInput;
- (void)beginInputCalibration;
- (void)sampleInputCalibrationBoosted:(BOOL)boosted;
- (void)cancelInputCalibration;
- (void)useAutomaticInputLevels;
// Called by the UI on the main thread. PID zero disarms typing.
- (void)setTypingDestination:(pid_t)pid;
- (void)drainTypedCharacters:(void (^)(pid_t pid, char character, BOOL spaceBefore))receive;
- (void)start;
- (void)stop;
@end
