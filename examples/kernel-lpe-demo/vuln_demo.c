// Synthetic "vulnerable" kernel module used as teaching material.
// It is not a real module and cannot be loaded into any kernel.
//
// The bug shape is the classic check-then-use: `refcount` is tested without
// the lock that protects it, so two threads can both pass the check and free
// the same object. A second bug keeps the object in the device's array after
// free, which is what gives the exploit a stale handle (use-after-free).

#include <linux/cdev.h>
#include <linux/fs.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/slab.h>
#include <linux/types.h>
#include <linux/uaccess.h>

#define VULN_IOC_ALLOC  0x4008d001
#define VULN_IOC_FREE   0x4008d002
#define VULN_IOC_READ   0x8008d003
#define VULN_IOC_WRITE  0x4008d004
#define VULN_IOC_RACE   0x0008d005
#define VULN_MAX        16

struct vuln_obj {
    u64 size;
    u64 data;
    u32 flags;
    u32 refcnt;
};

struct vuln_state {
    struct mutex lock;
    struct vuln_obj *slots[VULN_MAX];
};

static struct vuln_state *state;
static dev_t devno;
static struct cdev cdev;

static int find_free_slot(struct vuln_state *st)
{
    for (int i = 0; i < VULN_MAX; i++)
        if (!st->slots[i])
            return i;
    return -ENOMEM;
}

static long vuln_alloc(struct vuln_state *st, unsigned long arg)
{
    u64 size = 0;
    int slot;

    if (copy_from_user(&size, (void __user *)arg, sizeof(size)))
        return -EFAULT;
    if (size == 0 || size > PAGE_SIZE)
        return -EINVAL;

    slot = find_free_slot(st);
    if (slot < 0)
        return -ENOMEM;
    st->slots[slot] = kzalloc(sizeof(struct vuln_obj), GFP_KERNEL);
    if (!st->slots[slot])
        return -ENOMEM;
    st->slots[slot]->size = size;
    st->slots[slot]->refcnt = 1;
    return 0;
}

static long vuln_free(struct vuln_state *st)
{
    int slot = 0;

    mutex_lock(&st->lock);
    if (!st->slots[slot]) {
        mutex_unlock(&st->lock);
        return -EINVAL;
    }
    // BUG: the refcount is read outside the lock that protects it, and the
    // slot is left populated after kfree(), so the pointer stays reachable.
    if (st->slots[slot]->refcnt-- == 0) {
        kfree(st->slots[slot]);
        st->slots[slot] = NULL;
    }
    mutex_unlock(&st->lock);
    return 0;
}

static long vuln_read(struct vuln_state *st, unsigned long arg)
{
    u64 value = 0;
    if (!st->slots[0])
        return -EINVAL;
    value = st->slots[0]->data;
    if (copy_to_user((void __user *)arg, &value, sizeof(value)))
        return -EFAULT;
    return 0;
}

static long vuln_write(struct vuln_state *st, unsigned long arg)
{
    u64 value = 0;
    if (!st->slots[0])
        return -EINVAL;
    if (copy_from_user(&value, (void __user *)arg, sizeof(value)))
        return -EFAULT;
    st->slots[0]->data = value;
    return 0;
}

static long vuln_ioctl(struct file *file, unsigned int cmd, unsigned long arg)
{
    struct vuln_state *st = file->private_data;

    switch (cmd) {
    case VULN_IOC_ALLOC:
        return vuln_alloc(st, arg);
    case VULN_IOC_FREE:
        return vuln_free(st);
    case VULN_IOC_READ:
        return vuln_read(st, arg);
    case VULN_IOC_WRITE:
        return vuln_write(st, arg);
    default:
        return -ENOTTY;
    }
}

static const struct file_operations vuln_fops = {
    .owner = THIS_MODULE,
    .unlocked_ioctl = vuln_ioctl,
};

static int __init vuln_init(void)
{
    state = kzalloc(sizeof(*state), GFP_KERNEL);
    if (!state)
        return -ENOMEM;
    mutex_init(&state->lock);
    alloc_chrdev_region(&devno, 0, 1, "vuln_demo");
    cdev_init(&cdev, &vuln_fops);
    cdev_add(&cdev, devno, 1);
    return 0;
}

static void __exit vuln_exit(void)
{
    cdev_del(&cdev);
    unregister_chrdev_region(devno, 1);
    kfree(state);
}

module_init(vuln_init);
module_exit(vuln_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("synthetic teaching module; do not load");
