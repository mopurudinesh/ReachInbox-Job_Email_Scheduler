import { Router, type Request, type Response } from 'express';
import { EmailStatus } from '@reachinbox/shared';
import { asyncHandler } from '../http.js';
import { searchEmails } from '../search-index.js';

const router = Router();

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (query.length < 1 || query.length > 200) {
    res.status(400).json({ success: false, error: { code: 'INVALID_QUERY', message: 'Search text must contain 1 to 200 characters.' } });
    return;
  }
  if (status && !Object.values(EmailStatus).includes(status as EmailStatus)) {
    res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Choose a valid email status filter.' } });
    return;
  }

  try {
    const results = await searchEmails(req.user!.id, query, status);
    res.json({ success: true, data: { results, count: results.length } });
  } catch {
    res.status(503).json({ success: false, error: { code: 'SEARCH_UNAVAILABLE', message: 'Search is temporarily unavailable. Try again later.' } });
  }
}));

export default router;
