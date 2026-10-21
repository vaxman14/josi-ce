// Test fixture: joins a new process job, starts a child that starts a
// grandchild, and answers IPC commands. Run only by windowsSupervisor.test.ts.
import { spawn } from 'node:child_process';
import { joinNewWindowsProcessJob } from '../../../core/dist/index.js';

const job = joinNewWindowsProcessJob();
const sleeper = 'setInterval(() => {}, 1000)';
const parent = `const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { stdio: 'ignore' });
process.stdout.write(String(grandchild.pid) + '\\n'); setInterval(() => {}, 1000);`;
const child = spawn(process.execPath, ['-e', parent], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
child.stdout.setEncoding('utf8');
child.stdout.once('data', text => {
  process.send({ type: 'started', child: child.pid, grandchild: Number(text.trim()), others: job.others() });
});
process.on('message', message => {
  if (message === 'terminate') {
    job.terminateOthers();
    const deadline = Date.now() + 5000;
    const wait = () => {
      if (job.others() === 0 || Date.now() > deadline) process.send({ type: 'terminated', others: job.others() });
      else setTimeout(wait, 50);
    };
    wait();
  }
});
