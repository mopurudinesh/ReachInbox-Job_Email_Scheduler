import { Router, type NextFunction, type Request, type Response } from 'express';
import passport, { googleOAuthConfigured } from './passport.js';

const router = Router();

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
  (_req, res) => {
    const destination = new URL(process.env.WEB_URL || 'http://localhost:5173');
    destination.searchParams.set('signedIn', '1');
    res.redirect(destination.toString());
  },
);

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
