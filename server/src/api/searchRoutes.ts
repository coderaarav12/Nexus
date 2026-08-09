import { Router } from 'express';
import { requireAuth, authContext } from '../middleware/auth';
import { search } from '../services/searchService';
import { AuthError } from '../services/authService';

export const searchRouter = Router();

searchRouter.use(requireAuth);

searchRouter.get('/search', (req, res) => {
  const { user } = authContext(req);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  try {
    res.json({ results: search(q, user) });
  } catch (err) {
    if (err instanceof AuthError) res.status(err.status).json({ error: err.message });
    else res.status(500).json({ error: 'search failed' });
  }
});
