// Synthetic helpers for the teaching sample: logging and small utilities.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "utils.h"

void demo_log(const char *tag, const char *message)
{
    fprintf(stderr, "[%s] %s\n", tag ? tag : "demo", message ? message : "");
}

void *demo_alloc(size_t size)
{
    void *ptr = calloc(1, size);
    if (!ptr)
        demo_log("alloc", "out of memory");
    return ptr;
}

void demo_free(void *ptr)
{
    free(ptr);
}

uint64_t demo_align_up(uint64_t value, uint64_t alignment)
{
    if (alignment == 0)
        return value;
    return (value + alignment - 1) & ~(alignment - 1);
}

int demo_write_file(const char *path, const char *text)
{
    FILE *file = fopen(path, "w");
    if (!file)
        return -1;
    fputs(text, file);
    fclose(file);
    return 0;
}
