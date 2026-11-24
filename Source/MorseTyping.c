#include "MorseTyping.h"
#include <math.h>
#include <string.h>
#include <time.h>

static char decode(const char *marks) {
    static const struct { char text; const char *code; } alphabet[] = {
        {'a',".-"},{'b',"-..."},{'c',"-.-."},{'d',"-.."},{'e',"."},{'f',"..-."},
        {'g',"--."},{'h',"...."},{'i',".."},{'j',".---"},{'k',"-.-"},{'l',".-.."},
        {'m',"--"},{'n',"-."},{'o',"---"},{'p',".--."},{'q',"--.-"},{'r',".-."},
        {'s',"..."},{'t',"-"},{'u',"..-"},{'v',"...-"},{'w',".--"},{'x',"-..-"},
        {'y',"-.--"},{'z',"--.."},
        {'0',"-----"},{'1',".----"},{'2',"..---"},{'3',"...--"},{'4',"....-"},
        {'5',"....."},{'6',"-...."},{'7',"--..."},{'8',"---.."},{'9',"----."},
        {'.',".-.-.-"},{',',"--..--"},{'?',"..--.."},{'/',"-..-."},{'-',"-....-"},
        {'=',"-...-"},{'+',".-.-."},{'@',".--.-."},{'!',"-.-.--"},{':',"---..."},
        {';',"-.-.-."},{'"',".-..-."},{'\'',".----."},{'(',"-.--."},{')',"-.--.-"},
        {'_',"..--.-"},{'&',".-..."},{' ',".-.-"}
    };
    for (unsigned i=0; i<sizeof(alphabet)/sizeof(alphabet[0]); ++i)
        if (!strcmp(alphabet[i].code,marks)) return alphabet[i].text;
    return 0;
}

void initTypingQueue(TypingQueue *q) {
    atomic_init(&q->destination,0);
    atomic_init(&q->readIndex,0);
    atomic_init(&q->writeIndex,0);
}
// The generation also distinguishes two visits to the same application.
static uint64_t newDestination(uint64_t old, uint32_t pid) {
    return ((old + (UINT64_C(1)<<32)) & UINT64_C(0xffffffff00000000)) | pid;
}
void selectTypingDestination(TypingQueue *q, pid_t pid) {
    uint64_t old=atomic_load(&q->destination);
    while ((uint32_t)old!=(uint32_t)pid &&
           !atomic_compare_exchange_weak(&q->destination,&old,newDestination(old,(uint32_t)pid))) {}
}
void resetTypingSession(TypingQueue *q) {
    uint64_t old=atomic_load(&q->destination);
    while (!atomic_compare_exchange_weak(&q->destination,&old,newDestination(old,(uint32_t)old))) {}
}
static void enqueue(TypingQueue *q, uint64_t destination, char character, bool spaceBefore) {
    unsigned write=atomic_load_explicit(&q->writeIndex,memory_order_relaxed);
    if (write-atomic_load_explicit(&q->readIndex,memory_order_acquire)>=TypingQueueSize) return;
    q->slots[write%TypingQueueSize]=(TypedCharacter){destination,clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW),character,spaceBefore};
    atomic_store_explicit(&q->writeIndex,write+1,memory_order_release);
}
bool takeTypedCharacter(TypingQueue *q, TypedCharacter *result) {
    unsigned read=atomic_load_explicit(&q->readIndex,memory_order_relaxed);
    unsigned write=atomic_load_explicit(&q->writeIndex,memory_order_acquire);
    while (read!=write) {
        TypedCharacter item=q->slots[read%TypingQueueSize];
        atomic_store_explicit(&q->readIndex,++read,memory_order_release);
        if (item.destination==atomic_load(&q->destination) &&
            clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)-item.createdNs<UINT64_C(1000000000)) {
            *result=item; return true;
        }
    }
    return false;
}
void prepareTypingBlock(TypingDecoder *d, TypingQueue *q, bool neutral) {
    uint64_t target=atomic_load_explicit(&q->destination,memory_order_relaxed);
    if (d->destination!=target) *d=(TypingDecoder){.destination=target};
    if ((uint32_t)target && neutral) d->armed=true;
}
void advanceTyping(TypingDecoder *d, TypingQueue *q, uint64_t now) {
    if (!d->armed || !d->hasMark || now<d->lastEnd) return;
    uint64_t silence=now-d->lastEnd;
    double unit=d->lastUnitFrames;
    if (d->length && silence>=(uint64_t)llround(3*unit)) {
        char character=d->length<sizeof(d->marks) ? decode(d->marks) : 0;
        if (character) {
            enqueue(q,d->destination,character,d->timedSpaces && d->wordGap && character!=' ');
            d->hasText=character!=' '; d->wordGap=false;
        }
        d->length=0;
    }
    if (d->timedSpaces && d->hasText && silence>=(uint64_t)llround(7*unit)) d->wordGap=true;
}
void typeMark(TypingDecoder *d, TypingQueue *q, unsigned element,
              uint64_t start, uint32_t duration, double gapUnit, bool timedSpaces) {
    if (!d->armed) return;
    advanceTyping(d,q,start);
    if (timedSpaces!=d->timedSpaces) d->wordGap=false;
    d->timedSpaces=timedSpaces;
    if (d->length<sizeof(d->marks)-1) {
        d->marks[d->length++]=element==1 ? '.' : '-';
        d->marks[d->length]='\0';
    } else d->length=sizeof(d->marks);
    d->lastEnd=start+duration; d->lastUnitFrames=gapUnit; d->hasMark=true;
}
