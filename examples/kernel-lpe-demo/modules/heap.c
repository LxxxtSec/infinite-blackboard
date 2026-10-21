// Synthetic heap helper: prepares and sprays fake objects for the walkthrough.
#include <stdlib.h>
#include <string.h>
#include "heap.h"
#include "net.h"
#include "utils.h"

#define DEMO_MAX_REGIONS 32

static struct demo_region regions[DEMO_MAX_REGIONS];
static int prepared;

int heap_prepare(size_t object_size, int count)
{
    if (object_size == 0 || count <= 0 || count > DEMO_MAX_REGIONS)
        return -1;
    for (int i = 0; i < count; i++) {
        regions[i].size = object_size;
        regions[i].base = demo_alloc(object_size);
        if (!regions[i].base)
            return -1;
        regions[i].in_use = 0;
    }
    prepared = count;
    demo_log("heap", "regions prepared");
    return 0;
}

int heap_spray(const void *pattern, size_t size, int count)
{
    if (!prepared)
        return -1;
    for (int i = 0; i < count && i < prepared; i++) {
        if (size > regions[i].size)
            return -1;
        memcpy(regions[i].base, pattern, size);
        regions[i].in_use = 1;
    }
    net_notify("heap sprayed");
    return 0;
}

void heap_release(void)
{
    for (int i = 0; i < prepared; i++)
        demo_free(regions[i].base);
    prepared = 0;
}
