import './load-env.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import session from 'express-session';
import { ApiResponse } from '@reachinbox/shared';
import passport from './auth/passport.js';
import authRoutes from './auth/routes.js';
import { PrismaSessionStore } from './auth/prisma-session-store.js';
import { requireAuth } from './auth/routes.js';
import senderRoutes from './routes/senders.js';
import campaignRoutes from './routes/campaigns.js';
import slackRoutes from './routes/slack.js';
import searchRoutes from './routes/search.js';
import emailRoutes from './routes/emails.js';
import { requireQueueAdmin } from './middleware/queue-admin.js';
import { ensureEmailIndex } from './search-index.js';
import { emailQueue } from './email-queue.js';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { createBullBoard } from '@bull-board/api';
import { ExpressAdapter } from '@bull-board/express';

const app = express();
const port = process.env.API_PORT || 4000;
const sessionSecret = process.env.SESSION_SECRET || '';

if (sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be set to at least 32 characters.');
}

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const isProduction = process.env.NODE_ENV === 'production';
const webUrl = (process.env.WEB_URL || 'http://localhost:5173').replace(/\/$/, '');

app.use(cors({
  origin: [webUrl, `${webUrl}/`, 'http://localhost:5173', 'http://localhost:5173/'],
  credentials: true,
}));

app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'reachinbox.sid',
  secret: sessionSecret,
  store: new PrismaSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'none',
    secure: isProduction,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));
app.use(passport.initialize());
app.use(passport.session());
app.use('/api/auth', authRoutes);
app.use('/api/senders', requireAuth, senderRoutes);
app.use('/api/campaigns', requireAuth, campaignRoutes);
app.use('/api/emails', requireAuth, emailRoutes);
app.use('/api/integrations/slack', requireAuth, slackRoutes);
app.use('/api/search', requireAuth, searchRoutes);

const queueDashboard = new ExpressAdapter();
queueDashboard.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter: queueDashboard });
app.use('/admin/queues', requireQueueAdmin, queueDashboard.getRouter());

void ensureEmailIndex().catch(() => {
  console.warn('[ReachInbox API] Elasticsearch is unavailable; search requests will return a recoverable error.');
});

// Health Check Endpoint
app.get('/health', (_req: Request, res: Response) => {
  const response: ApiResponse<{ status: string; uptime: number; timestamp: string }> = {
    success: true,
    data: {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  };
  res.json(response);
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (process.env.NODE_ENV === 'production') {
    console.error('[ReachInbox API] Request failed.');
  } else {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[ReachInbox API] Request failed: ${reason}`);
  }
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' },
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`[ReachInbox API] Server running on http://localhost:${port}`);
  });
}

export default app;

