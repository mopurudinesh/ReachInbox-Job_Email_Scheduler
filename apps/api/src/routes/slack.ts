import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { prisma } from '../db.js';
import { asyncHandler } from '../http.js';
import { decryptToken, encryptToken, tokenEncryptionConfigured } from '../token-crypto.js';

const router = Router();
const webUrl = process.env.WEB_URL || 'http://localhost:5173';
const redirectUri = process.env.SLACK_REDIRECT_URI || 'http://localhost:4000/api/integrations/slack/callback';

function configurationMissing(): boolean {
  return !process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET ||
    process.env.SLACK_CLIENT_ID.startsWith('your_') || !tokenEncryptionConfigured();
}

router.get('/connect', (req: Request, res: Response) => {
  if (configurationMissing()) {
    res.status(503).json({ success: false, error: { code: 'SLACK_NOT_CONFIGURED', message: 'Add Slack OAuth credentials and a token encryption key to the root .env file.' } });
    return;
  }

  const state = randomBytes(32).toString('hex');
  req.session.slackOAuthState = state;
  req.session.save((error) => {
    if (error) {
      res.status(500).json({ success: false, error: { code: 'SESSION_SAVE_FAILED', message: 'Could not start Slack authorization.' } });
      return;
    }
    const authorize = new URL('https://slack.com/oauth/v2/authorize');
    authorize.searchParams.set('client_id', process.env.SLACK_CLIENT_ID!);
    authorize.searchParams.set('scope', 'chat:write,incoming-webhook');
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', state);
    res.redirect(authorize.toString());
  });
});

router.get('/callback', asyncHandler(async (req: Request, res: Response) => {
  if (configurationMissing()) {
    res.redirect(`${webUrl}/settings?slack=not-configured`);
    return;
  }

  if (typeof req.query.error === 'string') {
    delete req.session.slackOAuthState;
    res.redirect(`${webUrl}/settings?slack=cancelled`);
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!code || !state || !req.session.slackOAuthState || state !== req.session.slackOAuthState) {
    res.status(400).json({ success: false, error: { code: 'SLACK_STATE_INVALID', message: 'Slack authorization could not be verified. Please reconnect.' } });
    return;
  }
  delete req.session.slackOAuthState;

  const body = new URLSearchParams({ code, redirect_uri: redirectUri });
  const basicAuth = Buffer.from(`${process.env.SLACK_CLIENT_ID}:${process.env.SLACK_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { authorization: `Basic ${basicAuth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error('Slack token exchange request failed.');

  const result = await response.json() as {
    ok?: boolean;
    access_token?: string;
    team?: { id?: string; name?: string };
    incoming_webhook?: { url?: string; channel?: string; channel_id?: string };
  };
  if (!result.ok || !result.access_token || !result.team?.id) {
    res.redirect(`${webUrl}/settings?slack=error`);
    return;
  }

  await prisma.slackIntegration.upsert({
    where: { userId_teamId: { userId: req.user!.id, teamId: result.team.id } },
    create: {
      userId: req.user!.id,
      teamId: result.team.id,
      teamName: result.team.name || 'Slack workspace',
      accessTokenEncrypted: encryptToken(result.access_token),
      incomingWebhookEncrypted: result.incoming_webhook?.url ? encryptToken(result.incoming_webhook.url) : null,
      channel: result.incoming_webhook?.channel || null,
      channelId: result.incoming_webhook?.channel_id || null,
    },
    update: {
      teamName: result.team.name || 'Slack workspace',
      accessTokenEncrypted: encryptToken(result.access_token),
      incomingWebhookEncrypted: result.incoming_webhook?.url ? encryptToken(result.incoming_webhook.url) : null,
      channel: result.incoming_webhook?.channel || null,
      channelId: result.incoming_webhook?.channel_id || null,
    },
  });
  res.redirect(`${webUrl}/settings?slack=connected`);
}));

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const integrations = await prisma.slackIntegration.findMany({
    where: { userId: req.user!.id },
    select: { id: true, teamId: true, teamName: true, channel: true, channelId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: integrations });
}));

router.delete('/', asyncHandler(async (req: Request, res: Response) => {
  const integrations = await prisma.slackIntegration.findMany({ where: { userId: req.user!.id } });
  for (const integration of integrations) {
    try {
      const accessToken = decryptToken(integration.accessTokenEncrypted);
      await fetch('https://slack.com/api/auth.revoke', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({}),
      });
    } catch {
      // Local disconnect must still work if Slack is unavailable or the token was revoked already.
    }
  }
  await prisma.slackIntegration.deleteMany({ where: { userId: req.user!.id } });
  res.json({ success: true, data: { disconnected: true } });
}));

export default router;
