/** Monotonic seconds. Injectable so tests can control time (REQ-021). */
export interface Clock { monoNow(): number; }
export const systemClock: Clock = {
  monoNow: () => Number(process.hrtime.bigint()) / 1e9,
};
