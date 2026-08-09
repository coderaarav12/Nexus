import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../lib/crypto';
import { findUserById } from '../services/authService';
import { findNodeByToken } from '../services/gatewayService';
import type { AuthContext, UserRow } from '../types';

export interface AuthRequest extends Request {
  user?: UserRow;
  deviceId?: number;
  node?: any;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing access token' });
    return;
  }
  const payload = verifyAccessToken(auth.slice(7));
  if (!payload) {
    res.status(401).json({ error: 'invalid or expired access token' });
    return;
  }
  const user = findUserById(payload.uid);
  if (!user) {
    res.status(401).json({ error: 'user not found' });
    return;
  }
  req.user = user;
  req.deviceId = payload.did;
  next();
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'admin required' });
    return;
  }
  next();
}

export function authContext(req: AuthRequest): AuthContext {
  if (!req.user) throw new Error('auth required');
  return { user: req.user, deviceId: req.deviceId };
}

export function requireAgent(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing agent token' });
    return;
  }
  const node = findNodeByToken(auth.slice(7));
  if (!node) {
    res.status(401).json({ error: 'invalid agent token' });
    return;
  }
  req.node = node;
  next();
}

export function clientIp(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip;
}
