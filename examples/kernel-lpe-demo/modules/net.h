#ifndef DEMO_NET_H
#define DEMO_NET_H

int net_open(const char *name);
int net_send(const void *data, unsigned int length);
void net_notify(const char *message);
void net_close(void);

#endif
