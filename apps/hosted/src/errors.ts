/** A refusal with words a person can read. Anything else becomes a plain 500. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}
