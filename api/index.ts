import type { Request, Response } from 'express';
import { createApiApp } from '../server/app.ts';

const app = createApiApp();

export default function handler(req: Request, res: Response) {
  if (req.url && req.url.startsWith('/api/index')) {
    const idx = req.url.indexOf('?');
    const query = idx >= 0 ? new URLSearchParams(req.url.slice(idx + 1)) : null;
    const rewrittenPath = query?.get('__path');
    if (rewrittenPath) {
      query!.delete('__path');
      const remaining = query!.toString();
      req.url = `/api/${rewrittenPath}${remaining ? `?${remaining}` : ''}`;
    }
  }
  return app(req, res);
}
