import express, { Request, Response, NextFunction } from 'express';
import { getConfig } from '../config/config';
import { handleAlchemy } from './alchemyHandler';
import { handleHelius } from './heliusHandler';
import logger from '../logger';

// Extend Request to carry raw body for HMAC verification
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export function startWebhookServer(): void {
  const cfg = getConfig();
  const app = express();

  // Capture raw body before JSON parsing (needed for Alchemy HMAC)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      try {
        req.body = JSON.parse(req.rawBody.toString('utf-8'));
      } catch {
        req.body = {};
      }
      next();
    });
  });

  app.post('/webhook/alchemy', (req: Request, res: Response) => {
    handleAlchemy(req, res).catch(err => {
      logger.error('Alchemy handler error', { err });
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  });

  app.post('/webhook/helius', (req: Request, res: Response) => {
    handleHelius(req, res).catch(err => {
      logger.error('Helius handler error', { err });
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  });

  app.listen(cfg.webhook.port, () => {
    logger.info(`Webhook server listening on port ${cfg.webhook.port}`);
    if (cfg.webhook.public_url) {
      logger.info(`  Alchemy endpoint: ${cfg.webhook.public_url}/webhook/alchemy`);
      logger.info(`  Helius endpoint:  ${cfg.webhook.public_url}/webhook/helius`);
    } else {
      logger.warn('webhook.public_url not set — providers cannot reach this server');
    }
  });
}
