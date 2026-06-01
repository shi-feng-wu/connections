import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchPuzzle, todayET, randomDate, isValidDate, FIRST_DATE } from './_nyt.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const dateParam = typeof req.query.date === 'string' ? req.query.date : undefined;
    if (dateParam && !isValidDate(dateParam)) {
      res.status(400).json({ error: `Date must be between ${FIRST_DATE} and ${todayET()}.` });
      return;
    }
    const date = dateParam ?? (req.query.random ? randomDate() : todayET());
    const puzzle = await fetchPuzzle(date);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(puzzle);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'error';
    res.status(message === 'NOT_FOUND' ? 404 : 502).json({ error: message });
  }
}
