#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <sys/types.h>

typedef struct {
    uint64_t destination, createdNs;
    char character;
    bool spaceBefore;
} TypedCharacter;

// One audio producer and one main-thread consumer. The render thread never waits.
enum { TypingQueueSize = 128 };
typedef struct {
    _Atomic(uint64_t) destination;
    atomic_uint readIndex, writeIndex;
    TypedCharacter slots[TypingQueueSize];
} TypingQueue;

typedef struct {
    uint64_t destination, lastEnd;
    double lastUnitFrames;
    char marks[8];
    unsigned length;
    bool armed, hasMark, hasText, wordGap, timedSpaces;
} TypingDecoder;

void initTypingQueue(TypingQueue *queue);
void selectTypingDestination(TypingQueue *queue, pid_t pid);
void resetTypingSession(TypingQueue *queue);
bool takeTypedCharacter(TypingQueue *queue, TypedCharacter *result);
void prepareTypingBlock(TypingDecoder *decoder, TypingQueue *queue, bool neutral);
void advanceTyping(TypingDecoder *decoder, TypingQueue *queue, uint64_t now);
void typeMark(TypingDecoder *decoder, TypingQueue *queue, unsigned element,
              uint64_t start, uint32_t duration, double gapUnit, bool timedSpaces);
