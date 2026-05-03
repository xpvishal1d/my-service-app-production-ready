import { env } from "../config/env.js";
import { GRID_BITMAP_KEY, redis } from "./redis.js";

export const GRID_COLS = env.GRID_COLS;
export const GRID_ROWS = env.GRID_ROWS;
export const TOTAL_CELLS = GRID_COLS * GRID_ROWS;
export const STATE_BYTE_LENGTH = Math.ceil(TOTAL_CELLS / 8);

/** Atomic GETBIT → flip → SETBIT to avoid lost updates when many users toggle quickly. */
const TOGGLE_LUA = `
local offset = tonumber(ARGV[1])
if offset == nil then return redis.error_reply('bad_offset') end
local cur = redis.call('GETBIT', KEYS[1], offset)
local nxt = 1 - cur
redis.call('SETBIT', KEYS[1], offset, nxt)
return nxt
`;

export function indexInRange(index: number) {
  return Number.isInteger(index) && index >= 0 && index < TOTAL_CELLS;
}

export async function getStateBytes(): Promise<Buffer> {
  const buf = await redis.getBuffer(GRID_BITMAP_KEY);
  if (!buf || buf.length === 0) {
    return Buffer.alloc(STATE_BYTE_LENGTH);
  }
  if (buf.length >= STATE_BYTE_LENGTH) {
    return Buffer.from(buf.subarray(0, STATE_BYTE_LENGTH));
  }
  const out = Buffer.alloc(STATE_BYTE_LENGTH);
  buf.copy(out);
  return out;
}

export async function getBit(index: number): Promise<0 | 1> {
  const v = await redis.getbit(GRID_BITMAP_KEY, index);
  return v === 1 ? 1 : 0;
}

export async function setBit(index: number, value: 0 | 1) {
  await redis.setbit(GRID_BITMAP_KEY, index, value);
}

export async function toggleBit(index: number): Promise<0 | 1> {
  const n = (await redis.eval(TOGGLE_LUA, 1, GRID_BITMAP_KEY, String(index))) as number;
  return n === 1 ? 1 : 0;
}
