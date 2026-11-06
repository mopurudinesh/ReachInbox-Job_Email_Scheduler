import session from 'express-session';
import { prisma } from '../db.js';

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class PrismaSessionStore extends session.Store {
  get(
    sid: string,
    callback: (err: unknown, sessionData?: session.SessionData | null) => void,
  ): void {
    void prisma.session
      .findUnique({ where: { sid } })
      .then(async (record) => {
        if (!record || record.expiresAt <= new Date()) {
          if (record) await prisma.session.delete({ where: { sid } });
          callback(null, null);
          return;
        }

        callback(null, record.data as unknown as session.SessionData);
      })
      .catch(callback);
  }

  set(sid: string, sessionData: session.SessionData, callback?: (err?: unknown) => void): void {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires)
      : new Date(Date.now() + DEFAULT_SESSION_TTL_MS);
    const userId = typeof sessionData.passport?.user === 'string'
      ? sessionData.passport.user
      : null;
    const data = JSON.parse(JSON.stringify(sessionData)) as object;

    void prisma.session
      .upsert({
        where: { sid },
        create: { sid, userId, data, expiresAt },
        update: { userId, data, expiresAt },
      })
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    void prisma.session
      .deleteMany({ where: { sid } })
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  touch(sid: string, sessionData: session.SessionData, callback?: (err?: unknown) => void): void {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires)
      : new Date(Date.now() + DEFAULT_SESSION_TTL_MS);

    void prisma.session
      .updateMany({ where: { sid }, data: { expiresAt } })
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }
}
