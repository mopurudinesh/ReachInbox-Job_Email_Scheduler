import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import passport, { googleOAuthConfigured } from './passport.js';
import { prisma } from '../db.js';

const router = Router();

function createAuthToken(userId: string): string {
  const secret = process.env.SESSION_SECRET || 'reachinbox_default_secret_key_32c';
  const timestamp = Date.now();
  const data = `${userId}:${timestamp}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ userId, timestamp, signature })).toString('base64url');
}

function verifyAuthToken(token: string): string | null {
  try {
    const secret = process.env.SESSION_SECRET || 'reachinbox_default_secret_key_32c';
    const jsonStr = Buffer.from(token, 'base64url').toString('utf8');
    const { userId, timestamp, signature } = JSON.parse(jsonStr) as { userId?: string; timestamp?: number; signature?: string };
    if (!userId || !timestamp || !signature) return null;
    if (Date.now() - timestamp > 5 * 60 * 1000) return null;
    const expected = crypto.createHmac('sha256', secret).update(`${userId}:${timestamp}`).digest('hex');
    if (signature === expected) {
      return userId;
    }
  } catch {
    return null;
  }
  return null;
}

router.get('/google', (req, res, next) => {
  if (!googleOAuthConfigured) {
    res.status(503).json({
      success: false,
      error: {
        code: 'OAUTH_NOT_CONFIGURED',
        message: 'Google sign-in is not configured. Add OAuth credentials to the root .env file.',
      },
    });
    return;
  }

  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

router.get(
  '/google/callback',
  (_req, res, next) => {
    if (!googleOAuthConfigured) {
      res.status(503).json({ success: false, error: { code: 'OAUTH_NOT_CONFIGURED', message: 'Google sign-in is not configured.' } });
      return;
    }
    next();
  },
  passport.authenticate('google', { failureRedirect: `${(process.env.WEB_URL || 'http://localhost:5173').replace(/\/$/, '')}/?error=oauth` }),
  (req, res) => {
    const destination = new URL(process.env.WEB_URL || 'http://localhost:5173');
    destination.searchParams.set('signedIn', '1');
    if (req.user?.id) {
      destination.searchParams.set('token', createAuthToken(req.user.id));
    }
    res.redirect(destination.toString());
  },
);

router.post('/verify-token', async (req: Request, res: Response) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    res.status(400).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Token is required.' } });
    return;
  }
  const userId = verifyAuthToken(token);
  if (!userId) {
    res.status(401).json({ success: false, error: { code: 'EXPIRED_TOKEN', message: 'Token is invalid or expired.' } });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User was not found.' } });
    return;
  }
  const sessionUser = { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl };
  req.login(sessionUser, (err) => {
    if (err) {
      res.status(500).json({ success: false, error: { code: 'LOGIN_FAILED', message: 'Could not establish session.' } });
      return;
    }
    res.json({ success: true, data: { authenticated: true, user: sessionUser } });
  });
});

router.get('/session', (req: Request, res: Response) => {
  if (!req.isAuthenticated() || !req.user) {
    res.json({ success: true, data: { authenticated: false, user: null } });
    return;
  }

  res.json({ success: true, data: { authenticated: true, user: req.user } });
});

router.post('/logout', (req: Request, res: Response, next: NextFunction) => {
  req.logout((logoutError) => {
    if (logoutError) {
      next(logoutError);
      return;
    }

    req.session.destroy((sessionError) => {
      if (sessionError) {
        next(sessionError);
        return;
      }

      res.clearCookie('reachinbox.sid');
      res.json({ success: true, data: { authenticated: false } });
    });
  });
});

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated()) {
    next();
    return;
  }

  res.status(401).json({
    success: false,
    error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' },
  });
}

export default router;
