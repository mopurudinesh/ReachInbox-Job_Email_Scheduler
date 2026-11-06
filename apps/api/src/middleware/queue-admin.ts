import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

function constantTimeMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export function requireQueueAdmin(req: Request, res: Response, next: NextFunction): void {
  const expectedUser = process.env.BULL_BOARD_USER;
  const expectedPassword = process.env.BULL_BOARD_PASSWORD;
  if (!expectedUser || !expectedPassword || expectedPassword.startsWith('your_') || expectedPassword === 'adminpassword') {
    res.status(503).json({ success: false, error: { code: 'QUEUE_DASHBOARD_NOT_CONFIGURED', message: 'Set a non-default Bull Board username and password in .env.' } });
    return;
  }

  const header = req.get('authorization') || '';
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) {
    res.set('WWW-Authenticate', 'Basic realm="ReachInbox queue dashboard"');
    res.sendStatus(401);
    return;
  }

  let credentials = '';
  try {
    credentials = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    res.sendStatus(401);
    return;
  }
  const separator = credentials.indexOf(':');
  const suppliedUser = separator >= 0 ? credentials.slice(0, separator) : '';
  const suppliedPassword = separator >= 0 ? credentials.slice(separator + 1) : '';
  if (!constantTimeMatch(suppliedUser, expectedUser) || !constantTimeMatch(suppliedPassword, expectedPassword)) {
    res.set('WWW-Authenticate', 'Basic realm="ReachInbox queue dashboard"');
    res.sendStatus(401);
    return;
  }
  next();
}
