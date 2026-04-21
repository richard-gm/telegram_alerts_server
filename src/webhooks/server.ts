import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { getConfig } from '../config/config';
import { handleHelius } from './heliusHandler';
import apiRouter from '../api/routes';
import logger from '../logger';


export function startWebhookServer(): void {
  const cfg = getConfig();
  const app = express();

  app.use(express.json());

  // REST API
  app.use('/api', apiRouter);

  app.post('/webhook/helius', (req: Request, res: Response) => {
    handleHelius(req, res).catch(err => {
      logger.error('Helius handler error', { err });
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  });

  // Serve built frontend in production
  const publicDir = path.join(process.cwd(), 'dist', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.listen(cfg.webhook.port, () => {
    logger.info(`Webhook server listening on port ${cfg.webhook.port}`);
    if (cfg.webhook.public_url) {
      logger.info(`  Helius endpoint: ${cfg.webhook.public_url}/webhook/helius`);
    } else {
      logger.warn('webhook.public_url not set — providers cannot reach this server');
    }
  });
}
