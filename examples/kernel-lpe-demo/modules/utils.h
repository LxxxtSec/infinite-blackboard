#ifndef DEMO_UTILS_H
#define DEMO_UTILS_H

#include <stdint.h>
#include <stddef.h>

void demo_log(const char *tag, const char *message);
void *demo_alloc(size_t size);
void demo_free(void *ptr);
uint64_t demo_align_up(uint64_t value, uint64_t alignment);
int demo_write_file(const char *path, const char *text);

#endif
