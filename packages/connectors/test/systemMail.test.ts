// The message Josi's own email becomes when it goes out through a connected
// account, and which connections may carry it.
import { describe, expect, it } from 'vitest';
import { buildAccountMime, grantsMailSend } from '../src/systemMail.js';

const message = { from: 'ignored <ignored@example.test>', replyTo: 'ignored@example.test', to: ['a@example.test'], cc: [],
  subject: 'Reset your Josi password', text: 'Use this link.\n\nhttps://josi.example.test/set-password?token=abc', headers: { 'Auto-Submitted': 'auto-generated' }, attachments: [] };
const sender = { fromName: 'Josi', fromAddress: 'owner@gmail.test' };
const body = (mime: string) => Buffer.from(mime.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8');

describe('account mail message', () => {
  it('is addressed from the connected account, whatever the caller put in From', () => {
    const mime = buildAccountMime(message, sender, '<id@gmail.test>');
    expect(mime).toContain('From: "Josi" <owner@gmail.test>');
    expect(mime).toContain('Reply-To: owner@gmail.test');
    expect(mime).not.toContain('ignored@example.test');
    expect(mime).toContain('To: a@example.test');
    expect(mime).toContain('Auto-Submitted: auto-generated');
    expect(mime).toContain('Message-ID: <id@gmail.test>');
    expect(body(mime)).toBe(message.text);
  });

  it('keeps long and non-ASCII text intact', () => {
    const text = 'Grüße aus Zürich — こんにちは\n'.repeat(40);
    const mime = buildAccountMime({ ...message, subject: 'Réinitialisation', text }, { ...sender, fromName: 'José' }, '<id@x.test>');
    expect(body(mime)).toBe(text);
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from('Réinitialisation').toString('base64')}?=`);
    expect(mime).toContain(`From: =?UTF-8?B?${Buffer.from('José').toString('base64')}?= <owner@gmail.test>`);
    for (const line of mime.split('\r\n\r\n')[1]!.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
  });

  it('cannot be given extra headers or recipients through a line break', () => {
    const mime = buildAccountMime({ ...message, subject: 'Hello\r\nBcc: thief@example.test', headers: { 'X-Note': 'a\r\nBcc: thief@example.test', 'Bad Name': 'x', To: 'thief@example.test' } },
      { ...sender, fromName: 'Josi\r\nBcc: thief@example.test' }, '<id@x.test>');
    const head = mime.split('\r\n\r\n')[0]!.split('\r\n');
    expect(head.filter((line) => /^bcc:/i.test(line))).toHaveLength(0);
    expect(head.filter((line) => /^to:/i.test(line))).toEqual(['To: a@example.test']);
    expect(head.some((line) => line.startsWith('Bad Name'))).toBe(false);
    expect(() => buildAccountMime({ ...message, to: ['a@example.test, thief@example.test'] }, sender, '<id@x.test>')).toThrow();
    expect(() => buildAccountMime({ ...message, to: [] }, sender, '<id@x.test>')).toThrow();
  });
});

describe('which connections may send', () => {
  it('needs the provider scope for sending mail', () => {
    expect(grantsMailSend({ provider: 'google', granted_scopes: 'openid https://www.googleapis.com/auth/gmail.send' })).toBe(true);
    expect(grantsMailSend({ provider: 'google', granted_scopes: 'openid https://www.googleapis.com/auth/gmail.readonly' })).toBe(false);
    expect(grantsMailSend({ provider: 'microsoft', granted_scopes: 'openid User.Read mail.send' })).toBe(true);
    expect(grantsMailSend({ provider: 'microsoft', granted_scopes: 'openid User.Read Mail.Read' })).toBe(false);
    expect(grantsMailSend({ provider: 'dropbox', granted_scopes: 'Mail.Send' })).toBe(false);
  });
});
