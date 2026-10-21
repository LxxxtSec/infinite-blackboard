#ifndef DEMO_HEAP_H
#define DEMO_HEAP_H

#include <stddef.h>

struct demo_region {
    void *base;
    size_t size;
    int in_use;
};

int heap_prepare(size_t object_size, int count);
int heap_spray(const void *pattern, size_t size, int count);
void heap_release(void);

#endif
