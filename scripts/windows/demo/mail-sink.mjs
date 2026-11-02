// The demo's mail server: a tiny SMTP sink on loopback that accepts every
// message and writes it to disk instead of delivering it. The demo Josi
// server is set up with it as its system and communications mail server, so
// "send an email" runs through Josi's real mail code and the result can be
// shown (the .eml lands in the demo's Files folder), with nothing leaving
// this PC.
//
//   node scripts/windows/demo/mail-sink.mjs [port] [folder]
//
// Defaults: port 2525 (JOSI_DEMO_MAIL_PORT), folder <demo root>\sample-files\mail
// (JOSI_DEMO_MAIL_DIR). Plain SMTP, no TLS; AUTH is accepted with any login.
import net from 'node:net';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const port = Number(process.argv[2] || process.env.JOSI_DEMO_MAIL_PORT || 2525);
const folder = process.argv[3] || process.env.JOSI_DEMO_MAIL_DIR || join(process.env.JOSI_DEMO_ROOT || 'C:\\Dev\\josi-demo', 'sample-files', 'mail');
const logFile = process.env.JOSI_DEMO_MAIL_LOG || '';
mkdirSync(folder, { recursive: true });

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  if (logFile) { try { appendFileSync(logFile, text + '\n'); } catch { /* the log is a convenience */ } }
}

/** A file name from the subject: "Launch plan summary" -> launch-plan-summary. */
function slug(text) {
  return (text || 'message').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'message';
}
function header(raw, name) {
  const match = new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t]+.*)*)`, 'im').exec(raw.split(/\r?\n\r?\n/)[0] || '');
  return match ? match[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

let count = 0;
function deliver(from, recipients, raw) {
  count++;
  const subject = header(raw, 'subject');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const name = `${stamp}-${String(count).padStart(2, '0')}-${slug(subject)}.eml`;
  mkdirSync(folder, { recursive: true });  // the demo seed recreates the Files folder between takes
  writeFileSync(join(folder, name), raw);
  // The index: what arrived, newest last, for scripts to read. Kept out of the
  // mail folder when JOSI_DEMO_MAIL_INDEX says where, so the Files page shows
  // only the messages.
  const indexFile = process.env.JOSI_DEMO_MAIL_INDEX || join(folder, 'index.json');
  mkdirSync(dirname(indexFile), { recursive: true });
  const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [];
  index.push({ file: name, from, to: recipients, subject, receivedAt: new Date().toISOString() });
  writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
  log(`delivered ${name} from ${from} to ${recipients.join(', ')}: ${subject}`);
}

const server = net.createServer((socket) => {
  let from = '', recipients = [], buffer = '', inData = false, data = '';
  const reply = (text) => socket.write(text + '\r\n');
  socket.setEncoding('utf8');
  reply('220 josi-demo mail sink ready');
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) { if (buffer.length > 16 * 1024 * 1024) socket.destroy(); return; }
        data = buffer.slice(0, end + 2).replace(/^\.\./gm, '.');
        buffer = buffer.slice(end + 5); inData = false;
        try { deliver(from, recipients, data); reply('250 2.0.0 message accepted'); } catch (error) { log(`not written: ${error.message}`); reply('451 4.3.0 could not write the message'); }
        from = ''; recipients = []; data = '';
        continue;
      }
      const eol = buffer.indexOf('\r\n');
      if (eol < 0) return;
      const line = buffer.slice(0, eol); buffer = buffer.slice(eol + 2);
      const verb = line.split(' ')[0].toUpperCase();
      if (verb === 'EHLO') { reply('250-josi-demo'); reply('250-AUTH PLAIN LOGIN'); reply('250-8BITMIME'); reply('250 SIZE 16777216'); }
      else if (verb === 'HELO') reply('250 josi-demo');
      else if (verb === 'AUTH') { if (/^AUTH LOGIN$/i.test(line)) { reply('334 VXNlcm5hbWU6'); authLogin = 2; } else reply('235 2.7.0 authentication accepted'); }
      else if (authLogin > 0) { authLogin--; reply(authLogin > 0 ? '334 UGFzc3dvcmQ6' : '235 2.7.0 authentication accepted'); }
      else if (verb === 'MAIL') { from = (/<([^>]*)>/.exec(line) || [, line.slice(10).trim()])[1]; reply('250 2.1.0 sender ok'); }
      else if (verb === 'RCPT') { recipients.push((/<([^>]*)>/.exec(line) || [, line.slice(8).trim()])[1]); reply('250 2.1.5 recipient ok'); }
      else if (verb === 'DATA') { inData = true; reply('354 end data with <CR><LF>.<CR><LF>'); }
      else if (verb === 'RSET') { from = ''; recipients = []; reply('250 2.0.0 ok'); }
      else if (verb === 'NOOP') reply('250 2.0.0 ok');
      else if (verb === 'STARTTLS') reply('454 4.7.0 TLS not available');
      else if (verb === 'QUIT') { reply('221 2.0.0 bye'); socket.end(); }
      else reply('500 5.5.1 command not recognised');
    }
  });
  let authLogin = 0;
  socket.on('error', (error) => log(`connection error: ${error.message}`));
});
server.listen(port, '127.0.0.1', () => log(`josi demo mail sink on 127.0.0.1:${port}, messages in ${folder}`));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
