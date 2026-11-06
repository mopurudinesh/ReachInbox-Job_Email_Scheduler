import '../load-env.js';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { prisma } from '../db.js';

export const googleOAuthConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  process.env.GOOGLE_CALLBACK_URL &&
  !process.env.GOOGLE_CLIENT_ID.startsWith('your_'),
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id: string, done) => {
  void prisma.user
    .findUnique({ where: { id } })
    .then((user) => {
      if (!user) {
        done(null, false);
        return;
      }

      done(null, {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      });
    })
    .catch(done);
});

if (googleOAuthConfigured) {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      callbackURL: process.env.GOOGLE_CALLBACK_URL!,
    },
    (_accessToken, _refreshToken, profile, done) => {
      void (async () => {
        const email = profile.emails?.[0]?.value?.trim().toLowerCase();
        if (!email) throw new Error('Google did not return an email address.');

        const emailVerified = (profile as typeof profile & { _json?: { email_verified?: boolean } })._json?.email_verified;
        if (emailVerified !== true) throw new Error('Google did not verify the returned email address.');

        const existingGoogleUser = await prisma.user.findUnique({ where: { googleId: profile.id } });
        const existingEmailUser = existingGoogleUser ? null : await prisma.user.findUnique({ where: { email } });
        if (existingEmailUser?.googleId && existingEmailUser.googleId !== profile.id) {
          throw new Error('This email is linked to a different Google sign-in account.');
        }
        const user = existingGoogleUser
          ? await prisma.user.update({
              where: { id: existingGoogleUser.id },
              data: { email, name: profile.displayName || email, avatarUrl: profile.photos?.[0]?.value ?? null, passwordHash: null },
            })
          : existingEmailUser
            ? await prisma.user.update({
                where: { id: existingEmailUser.id },
                data: { googleId: profile.id, name: profile.displayName || email, avatarUrl: profile.photos?.[0]?.value ?? null, passwordHash: null },
              })
            : await prisma.user.create({
                data: { googleId: profile.id, email, name: profile.displayName || email, avatarUrl: profile.photos?.[0]?.value ?? null },
              });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        };
      })()
        .then((user) => done(null, user))
        .catch((error: unknown) => done(error));
    },
  ));
}

export default passport;
