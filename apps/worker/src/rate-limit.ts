import Redis from 'ioredis';

const reservationScript = `
local now = tonumber(ARGV[1])
local delay = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local nextSend = tonumber(redis.call('GET', KEYS[1]) or '0')
if nextSend > now then
  return {0, nextSend - now, 'cooldown'}
end
local count = tonumber(redis.call('GET', KEYS[2]) or '0')
if count >= limit then
  return {0, 3600000 - (now % 3600000), 'hourly'}
end
count = redis.call('INCR', KEYS[2])
if count == 1 then
  redis.call('EXPIRE', KEYS[2], math.max(1, math.ceil((3600000 - (now % 3600000)) / 1000)))
end
redis.call('SET', KEYS[1], now + delay, 'PX', math.max(delay, 1000))
return {1, 0, 'ok'}
`;

export interface Reservation {
  allowed: boolean;
  retryAfterMs: number;
  reason: 'cooldown' | 'hourly' | 'ok';
  windowStart: Date;
}

export async function reserveSendSlot(
  redis: Redis,
  senderId: string,
  hourlyLimit: number,
  delaySeconds: number,
): Promise<Reservation> {
  const now = Date.now();
  const windowStartMs = Math.floor(now / 3_600_000) * 3_600_000;
  const result = await redis.eval(
    reservationScript,
    2,
    `sender:${senderId}:next-send`,
    `sender:${senderId}:hour:${windowStartMs}`,
    now,
    Math.max(delaySeconds * 1000, 0),
    hourlyLimit,
  ) as [number | string, number | string, string];

  return {
    allowed: Number(result[0]) === 1,
    retryAfterMs: Math.max(Number(result[1]), 1000),
    reason: result[2] as Reservation['reason'],
    windowStart: new Date(windowStartMs),
  };
}
