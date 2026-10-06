import { mkdirSync, existsSync, readFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash } from './core.mjs';

export class Journal {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.events = [];
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      if (raw && !raw.endsWith('\n')) throw new Error('Incomplete audit journal; preserve and review it before restarting.');
      for (const line of raw.split('\n').filter(Boolean)) {
        const event = JSON.parse(line), { digest, ...record } = event;
        if (record.sequence !== this.events.length + 1 || record.previous !== (this.events.at(-1)?.digest || 'GENESIS') || digest !== hash(record))
          throw new Error('Audit integrity check failed; preserve the journal for review.');
        this.events.push(event);
      }
    }
  }
  append(type, actor, requestId, data = {}) {
    const record = { sequence: this.events.length + 1, timestamp: new Date().toISOString(), type, actor, requestId,
      data, previous: this.events.at(-1)?.digest || 'GENESIS' };
    const event = { ...record, digest: hash(record) };
    // Single process writer. A failed/torn append is fatal to subsequent writes.
    if (this.failed) throw new Error('Audit journal unavailable.');
    let fd;
    try {
      fd = openSync(this.path, 'a', 0o600);
      const bytes = Buffer.from(JSON.stringify(event) + '\n');
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
      this.events.push(event);
      return event;
    } catch (error) { this.failed = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
