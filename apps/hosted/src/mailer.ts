import type { Config } from './config.js';

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

/** For a laptop. Config refuses this in production, because links in mail sign
 * people in and logs are read by more people than inboxes are. */
export const consoleMailer: Mailer = {
  async send(mail) { console.log(`--- mail to ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n---`); },
};

export function smtpMailer(config: Config['mail']): Mailer {
  let transport: Promise<{ sendMail(mail: Record<string, unknown>): Promise<unknown> }> | null = null;
  return {
    async send(mail) {
      transport ??= import('nodemailer').then(({ default: nodemailer }) => nodemailer.createTransport(config.smtpUrl!));
      await (await transport).sendMail({ from: config.from, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

export const mailerFor = (config: Config['mail']): Mailer => config.transport === 'smtp' ? smtpMailer(config) : consoleMailer;
