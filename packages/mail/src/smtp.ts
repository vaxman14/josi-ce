// The SMTP transport.
//
// nodemailer rather than a hand-written client: SMTP is AUTH mechanisms, TLS
// upgrade, MIME encoding and line-ending rules, and writing that from scratch
// to save one well-audited dependency would be a bad trade in software
// strangers run on their own hardware.
//
// The failure mapping is the point of this file. A bounce or a rejection quotes
// the message that caused it, so the server's own text never reaches a caller,
// a response body, or the audit log — only a category an operator can act on.
import { createTransport } from 'nodemailer';
export { NoProfileError, loadProfile } from './profiles.js';
import { MailError, type SendErrorCategory, type SmtpTransport } from './send.js';

export interface SmtpProfile {
  configurationVersion?: string;
  kind: 'system' | 'communications';
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'tls';
  username: string | null;
  password: string | null;
  fromName: string;
  fromAddress: string;
}

/** Turns a server's refusal into something an operator can act on.
 *
 * Deliberately coarse. The distinction that matters is what the human should
 * DO: fix credentials, fix the network, fix the address, wait, or look at the
 * message itself. */
export function classifySmtpError(err: unknown): SendErrorCategory {
  const code = String((err as { code?: string })?.code ?? '');
  const responseCode = Number((err as { responseCode?: number })?.responseCode ?? 0);
  if (code === 'EAUTH' || responseCode === 535 || responseCode === 534) return 'auth';
  if (['ECONNECTION', 'ETIMEDOUT', 'ECONNREFUSED', 'ESOCKET', 'EDNS'].includes(code)) return 'connection';
  if (responseCode === 550 || responseCode === 551 || responseCode === 553) return 'rejected_recipient';
  if (responseCode === 552 || responseCode === 554) return 'rejected_content';
  if (responseCode === 421 || responseCode === 450 || responseCode === 452) return 'rate_limited';
  return 'unknown';
}

/** The one call this module makes into nodemailer. */
export interface Transporter {
  sendMail(options: Record<string, unknown>): Promise<{ messageId?: string }>;
}

/** `transporter` is injected in tests, matching how `fetchImpl` is injected in
 * the connector and LLM packages. Mocking the module instead would test the
 * mock; this exercises the real function, which is what mutation M14 showed was
 * missing — nothing called `smtpTransport` at all, so its error sanitising was
 * unprotected. */
export function smtpTransport(profile: SmtpProfile, transporter?: Transporter): SmtpTransport {
  const mailer: Transporter = transporter ?? createTransport({
    host: profile.host,
    port: profile.port,
    secure: profile.security === 'tls',
    requireTLS: profile.security === 'starttls',
    auth: profile.username ? { user: profile.username, pass: profile.password ?? '' } : undefined,
  });

  return {
    async send(message) {
      try {
        const info = await mailer.sendMail({
          from: message.from,
          replyTo: message.replyTo,
          to: message.to,
          cc: message.cc.length ? message.cc : undefined,
          subject: message.subject,
          text: message.text,
          headers: message.headers,
          attachments: message.attachments.map((a) => ({
            filename: a.filename, contentType: a.contentType, content: a.content,
          })),
        });
        return { messageId: String(info.messageId ?? '') };
      } catch (err) {
        // The server's own words are dropped here, on purpose.
        throw new MailError('the mail server refused the message', classifySmtpError(err));
      }
    },
  };
}
