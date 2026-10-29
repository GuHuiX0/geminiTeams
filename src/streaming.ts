/** Incrementally decodes the artifact body from the controller's JSON stream.
 * Partial protocol JSON is never presented as an agent conversation.
 * The complete decision is still validated before publishing an artifact.
 */
export class ArtifactTextDecoder {
  private source = '';
  private cursor = -1;
  private done = false;
  push(chunk: string): string {
    if (this.done) return '';
    this.source += chunk;
    if (this.cursor < 0) {
      const match = /"body"\s*:\s*"/.exec(this.source);
      if (!match) return '';
      this.cursor = match.index + match[0].length;
    }
    let decoded = '';
    while (this.cursor < this.source.length) {
      const character = this.source[this.cursor]!;
      if (character === '"') { this.done = true; break; }
      if (character !== '\\') { decoded += character; this.cursor++; continue; }
      const escape = this.source[this.cursor + 1];
      if (escape === undefined) break;
      if (escape === 'u') {
        const hex = this.source.slice(this.cursor + 2, this.cursor + 6);
        if (hex.length < 4) break;
        if (!/^[\da-f]{4}$/i.test(hex)) throw new Error('Invalid Unicode escape in streamed artifact');
        decoded += String.fromCharCode(parseInt(hex, 16)); this.cursor += 6;
      } else {
        const escaped: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (!(escape in escaped)) throw new Error('Invalid escape in streamed artifact');
        decoded += escaped[escape]; this.cursor += 2;
      }
    }
    return decoded;
  }
}
