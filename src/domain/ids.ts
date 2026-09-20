/**
 * Sortable ids: a prefix plus a monotonic ULID. Sorting by id is sorting by creation
 * order, even for rows created in the same millisecond, on any SQL backend.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function ulid(): string {
  const now = Date.now();
  if (now <= lastTime) {
    // Same (or earlier) millisecond: increment the random part so ids stay monotonic.
    let i = RANDOM_LEN - 1;
    while (i >= 0 && lastRandom[i] === 31) {
      lastRandom[i] = 0;
      i--;
    }
    if (i >= 0) lastRandom[i] = (lastRandom[i] ?? 0) + 1;
  } else {
    lastTime = now;
    lastRandom = Array.from(randomBytes(RANDOM_LEN), (b) => b % 32);
  }
  return encodeTime(lastTime) + lastRandom.map((n) => ALPHABET[n]).join('');
}

export type IdPrefix =
  | 'ws'
  | 'idea'
  | 'itm'
  | 'rev'
  | 'src'
  | 'rel'
  | 'msg'
  | 'dec'
  | 'asm'
  | 'run'
  | 'syn'
  | 'gs'
  | 'step'
  | 'op'
  | 'job';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
