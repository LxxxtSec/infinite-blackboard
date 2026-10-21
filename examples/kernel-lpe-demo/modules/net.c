// Synthetic transport helper. The sample keeps it local and non-functioning.
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include "net.h"
#include "utils.h"

static int net_fd = -1;

int net_open(const char *name)
{
    struct sockaddr_un addr;
    if (!name || name[0] == '\0')
        return -1;
    net_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
    if (net_fd < 0)
        return -1;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, name, sizeof(addr.sun_path) - 1);
    demo_log("net", "ready");
    return 0;
}

int net_send(const void *data, unsigned int length)
{
    if (net_fd < 0 || !data || !length)
        return -1;
    demo_log("net", "send");
    return (int)send(net_fd, data, length, 0);
}

void net_notify(const char *message)
{
    unsigned int length = (unsigned int)strlen(message ? message : "");
    net_send(message, length);
}

void net_close(void)
{
    if (net_fd >= 0)
        close(net_fd);
    net_fd = -1;
}
