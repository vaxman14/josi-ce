import { createRequire } from 'node:module';

/** The Windows equivalent of an owned POSIX process group for a supervisor.
 * The calling process joins a new Job Object before it starts any consumer, so
 * every descendant is created inside the job with no assignment race and no
 * breakaway (BREAKAWAY_OK is never set). Closing the job's last handle — the
 * supervisor exiting for any reason — kills everything still inside it. */
export interface WindowsProcessJob {
  /** Processes in the job other than the supervisor itself. */
  others(): number;
  /** Terminate every member except the supervisor. Each process handle is
   * re-checked for membership before termination, so a reused PID outside the
   * job is never touched. */
  terminateOthers(): void;
}

const JobObjectBasicAccountingInformation = 1;
const JobObjectBasicProcessIdList = 3;
const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export function joinNewWindowsProcessJob(): WindowsProcessJob {
  if (process.platform !== 'win32' || process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new Error('Windows process jobs require 64-bit Windows');
  }
  const k = createRequire(import.meta.url)('koffi');
  const kernel = k.load('kernel32.dll');
  const createJob = kernel.func('intptr_t __stdcall CreateJobObjectW(void *, str16)');
  const setJob = kernel.func('int __stdcall SetInformationJobObject(intptr_t, int, void *, uint32)');
  const queryJob = kernel.func('int __stdcall QueryInformationJobObject(intptr_t, int, _Out_ void *, uint32, _Out_ uint32 *)');
  const assign = kernel.func('int __stdcall AssignProcessToJobObject(intptr_t, intptr_t)');
  const current = kernel.func('intptr_t __stdcall GetCurrentProcess()');
  const openProcess = kernel.func('intptr_t __stdcall OpenProcess(uint32, int, uint32)');
  const inJob = kernel.func('int __stdcall IsProcessInJob(intptr_t, intptr_t, _Out_ int *)');
  const terminate = kernel.func('int __stdcall TerminateProcess(intptr_t, uint32)');
  const close = kernel.func('int __stdcall CloseHandle(intptr_t)');
  const job = createJob(null, null);
  if (!job) throw new Error('Could not create a process job');
  try {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows;
    // BasicLimitInformation.LimitFlags is at offset 16.
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, 16);
    if (!setJob(job, JobObjectExtendedLimitInformation, limits, limits.length)) throw new Error();
    if (!assign(job, current())) throw new Error();
  } catch {
    close(job);
    throw new Error('Could not place the supervisor in its process job');
  }
  // The job handle is intentionally never closed: it lives exactly as long as
  // the supervisor, and its closure is what kills any surviving consumer.
  const active = (): number => {
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: ActiveProcesses at offset 40.
    const info = Buffer.alloc(48);
    if (!queryJob(job, JobObjectBasicAccountingInformation, info, info.length, null)) throw new Error('Process job query failed');
    return info.readUInt32LE(40);
  };
  return {
    others: () => Math.max(0, active() - 1),
    terminateOthers() {
      // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR ids.
      const capacity = 1024, list = Buffer.alloc(8 + 8 * capacity);
      if (!queryJob(job, JobObjectBasicProcessIdList, list, list.length, null)) {
        // More members than the buffer holds still fills the first entries.
        if (list.readUInt32LE(4) === 0) return;
      }
      const count = Math.min(list.readUInt32LE(4), capacity);
      for (let index = 0; index < count; index++) {
        const pid = Number(list.readBigUInt64LE(8 + 8 * index));
        if (pid === process.pid || pid <= 0) continue;
        const handle = openProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (!handle) continue;
        try {
          const member = [0];
          if (inJob(handle, job, member) && member[0]) terminate(handle, 1);
        } finally { close(handle); }
      }
    },
  };
}
