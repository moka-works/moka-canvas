/**
 * A document that cannot be read, with the stable code the problem channel
 * carries and the sentence that says where it went wrong.
 *
 * Kept apart from the codec so the director scene codec can refuse a scene
 * without importing the whole document codec, which imports it back.
 */
export class MokaCodecError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MokaCodecError";
  }
}
