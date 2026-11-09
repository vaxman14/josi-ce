// What travels inside a Noise session: HTTP requests, several at once, as small
// binary frames (Josi's API has no WebSockets, streams are server-sent events). One byte of type, four of stream id, the rest
// payload. The relay sees none of this.
import { concat, fromUtf8, utf8 } from './bytes.js';
import { MAX_FRAMED } from './noise.js';

export enum Frame {
  ReqHead = 1, ReqBody = 2, ReqEnd = 3,
  ResHead = 4, ResBody = 5, ResEnd = 6,
  Reset = 7,
  Ping = 8, Pong = 9,
  Control = 10,
}

const HEAD = 5;
/** The largest body piece one frame carries. */
export const MAX_PIECE = MAX_FRAMED - HEAD;

export interface MuxFrame { type: Frame; stream: number; payload: Uint8Array }

export function encodeFrame(type: Frame, stream: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const head = new Uint8Array(HEAD);
  head[0] = type;
  new DataView(head.buffer).setUint32(1, stream);
  return concat(head, payload);
}

export function decodeFrame(raw: Uint8Array): MuxFrame {
  if (raw.length < HEAD) throw new Error('Short frame');
  return { type: raw[0] as Frame, stream: new DataView(raw.buffer, raw.byteOffset + 1, 4).getUint32(0), payload: raw.subarray(HEAD) };
}

export const jsonFrame = (type: Frame, stream: number, value: unknown): Uint8Array => encodeFrame(type, stream, utf8(JSON.stringify(value)));
export const jsonPayload = <T>(frame: MuxFrame): T => JSON.parse(fromUtf8(frame.payload)) as T;

export function* pieces(body: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < body.length; at += MAX_PIECE) yield body.subarray(at, at + MAX_PIECE);
}

export type Headers2 = Array<[string, string]>;

export interface RequestHead { method: string; path: string; headers: Headers2 }
export interface ResponseHead { status: number; headers: Headers2 }
