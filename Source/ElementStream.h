#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>

// One render clock writes at a time. Route changes stop that clock before
// starting its successor. The UI drains this ring outside the audio callbacks.
typedef struct {
    uint64_t frame;
    double rate;
    unsigned epoch, kind; // 0 = idle watermark, 1 = key down, 2 = key up
} ElementEvent;

enum { ElementCapacity = 512 };
typedef struct {
    atomic_uint read, write, epoch;
    ElementEvent slots[ElementCapacity];
} ElementStream;

static inline void interruptElements(ElementStream *s) {
    if (s) atomic_fetch_add_explicit(&s->epoch,1,memory_order_release);
}
static inline void emitElement(ElementStream *s, unsigned epoch, unsigned kind, uint64_t frame, double rate) {
    if (!s) return;
    unsigned write=atomic_load_explicit(&s->write,memory_order_relaxed);
    if (write-atomic_load_explicit(&s->read,memory_order_acquire)>=ElementCapacity) {
        interruptElements(s);
        return;
    }
    s->slots[write%ElementCapacity]=(ElementEvent){frame,rate,epoch,kind};
    atomic_store_explicit(&s->write,write+1,memory_order_release);
}
static inline bool takeElement(ElementStream *s, ElementEvent *out) {
    unsigned read=atomic_load_explicit(&s->read,memory_order_relaxed);
    if (read==atomic_load_explicit(&s->write,memory_order_acquire)) return false;
    *out=s->slots[read%ElementCapacity];
    atomic_store_explicit(&s->read,read+1,memory_order_release);
    return true;
}
