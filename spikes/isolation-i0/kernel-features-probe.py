#!/usr/bin/env python3
"""Does this kernel (host, or gVisor's Sentry) offer what OpenShell's sandbox baseline needs?
OpenShell's support matrix requires Landlock ABI >= 3 and seccomp user notification. If a
gVisor sandbox does not offer them, OpenShell's own sandbox cannot run under runsc, which
decides whether OpenShell + runsc can ever attest ADR-0190 class L2.
Prints one JSON object. Standard library only (ctypes syscalls, x86_64 numbers)."""
import ctypes
import json
import os

libc = ctypes.CDLL(None, use_errno=True)
SYS_landlock_create_ruleset = 444
SYS_seccomp = 317
LANDLOCK_CREATE_RULESET_VERSION = 1
SECCOMP_GET_ACTION_AVAIL = 2
SECCOMP_RET_USER_NOTIF = 0x7FC00000
SECCOMP_RET_KILL_PROCESS = 0x80000000


def landlock_abi():
    r = libc.syscall(SYS_landlock_create_ruleset, None, ctypes.c_size_t(0), ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION))
    if r < 0:
        e = ctypes.get_errno()
        return {"abi": None, "errno": e, "error": os.strerror(e)}
    return {"abi": r}


def seccomp_action(action):
    a = ctypes.c_uint32(action)
    r = libc.syscall(SYS_seccomp, ctypes.c_uint(SECCOMP_GET_ACTION_AVAIL), ctypes.c_uint(0), ctypes.byref(a))
    if r < 0:
        e = ctypes.get_errno()
        return {"available": False, "errno": e, "error": os.strerror(e)}
    return {"available": True}


class SockFilter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_uint16), ("jt", ctypes.c_uint8), ("jf", ctypes.c_uint8), ("k", ctypes.c_uint32)]


class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_uint16), ("filter", ctypes.POINTER(SockFilter))]


def install_filter(flags):
    """Install an allow-all filter with the given flags in a child process; report the result.
    flags=0 is the control (must succeed); flags=8 (SECCOMP_FILTER_FLAG_NEW_LISTENER) is what
    seccomp user notification needs. GET_ACTION_AVAIL alone is not trusted: if the control
    action also fails, that probe cannot tell anything apart."""
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        libc.prctl(38, 1, 0, 0, 0)  # PR_SET_NO_NEW_PRIVS
        insns = (SockFilter * 1)(SockFilter(0x06, 0, 0, 0x7FFF0000))  # BPF_RET|BPF_K, SECCOMP_RET_ALLOW
        prog = SockFprog(1, insns)
        res = libc.syscall(SYS_seccomp, ctypes.c_uint(1), ctypes.c_uint(flags), ctypes.byref(prog))
        err = ctypes.get_errno()
        os.write(w, json.dumps({"result": res, "errno": err if res < 0 else 0,
                                "error": os.strerror(err) if res < 0 else ""}).encode())
        os._exit(0)
    os.close(w)
    os.waitpid(pid, 0)
    return json.loads(os.read(r, 4096).decode())


print(json.dumps({
    "seccomp_filter_flags0_control": install_filter(0),
    "seccomp_filter_new_listener": install_filter(8),
    "kernel": os.uname().release,
    "landlock": landlock_abi(),
    "seccomp_ret_kill_process": seccomp_action(SECCOMP_RET_KILL_PROCESS),
    "seccomp_ret_user_notif": seccomp_action(SECCOMP_RET_USER_NOTIF),
}, indent=1))
