"""OS-enforced CPU, memory and process bounds for native speech inference."""
import ctypes
from ctypes import wintypes
import os

_job = None


class BasicLimits(ctypes.Structure):
    _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                ('flags', wintypes.DWORD), ('min_working_set', ctypes.c_size_t),
                ('max_working_set', ctypes.c_size_t), ('active_processes', wintypes.DWORD),
                ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD),
                ('scheduling', wintypes.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in
                ('reads', 'writes', 'other', 'read_bytes', 'write_bytes', 'other_bytes')]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [('basic', BasicLimits), ('io', IoCounters),
                ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                ('peak_process_memory', ctypes.c_size_t), ('peak_job_memory', ctypes.c_size_t)]


class CpuRate(ctypes.Structure):
    _fields_ = [('flags', wintypes.DWORD), ('rate', wintypes.DWORD)]


def apply_voice_limits():
    apply_resource_limits(memory_gib=4, cpu_cores=4, processes=4)


def apply_resource_limits(*, memory_gib, cpu_cores, processes):
    global _job
    if not all(type(value) is int and 1 <= value <= 4 for value in (memory_gib, cpu_cores, processes)):
        raise ValueError('Invalid native resource policy')
    if _job is not None:
        return
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    for name, args, result in (
        ('CreateJobObjectW', [ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        ('GetCurrentProcess', [], wintypes.HANDLE),
        ('SetInformationJobObject', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        ('QueryInformationJobObject', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
        ('AssignProcessToJobObject', [wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        ('CloseHandle', [wintypes.HANDLE], wintypes.BOOL),
    ):
        function = getattr(kernel, name)
        function.argtypes, function.restype = args, result
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise RuntimeError('Windows speech resource protection is unavailable')
    try:
        limits = ExtendedLimits()
        # Active-process ceiling, aggregate committed memory, kill any remaining
        # children when the service exits. The handle is intentionally retained.
        limits.basic.flags = 0x8 | 0x200 | 0x2000
        limits.basic.active_processes = processes
        limits.job_memory = memory_gib * 1024 ** 3
        rate = CpuRate(0x1 | 0x4, max(1, min(10000, cpu_cores * 10000 // (os.cpu_count() or 1))))
        if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise RuntimeError('Windows speech memory protection is unavailable')
        if not kernel.SetInformationJobObject(handle, 15, ctypes.byref(rate), ctypes.sizeof(rate)):
            raise RuntimeError('Windows speech CPU protection is unavailable')
        verified = ExtendedLimits()
        if not kernel.QueryInformationJobObject(handle, 9, ctypes.byref(verified), ctypes.sizeof(verified), None):
            raise RuntimeError('Windows speech resource protection could not be verified')
        verified_rate = CpuRate()
        if not kernel.QueryInformationJobObject(handle, 15, ctypes.byref(verified_rate), ctypes.sizeof(verified_rate), None):
            raise RuntimeError('Windows CPU protection could not be verified')
        if (verified.job_memory != limits.job_memory or verified.basic.active_processes != processes
                or verified.basic.flags & limits.basic.flags != limits.basic.flags
                or verified_rate.flags != rate.flags or verified_rate.rate != rate.rate):
            raise RuntimeError('Windows speech limits did not take effect')
        if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
            raise RuntimeError('Windows speech process could not be constrained')
        _job = (kernel, handle)
    finally:
        if _job is None:
            kernel.CloseHandle(handle)
