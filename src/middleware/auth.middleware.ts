import type { Request, Response, NextFunction } from 'express';
import { verifyToken, type Role, type TokenPayload } from '../services/jwt.service.js';

export interface AuthedRequest extends Request {
  user?: TokenPayload;
}

/**
 * Verifies a Bearer JWT. Pass one or more roles to restrict the route
 * (e.g. requireAuth('doctor')); pass none to just require any valid token.
 */
export function requireAuth(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'missing_bearer_token' });
    }
    try {
      const payload = verifyToken(header.slice('Bearer '.length));
      if (roles.length > 0 && !roles.includes(payload.role)) {
        return res.status(403).json({ success: false, error: 'forbidden_role' });
      }
      req.user = payload;
      next();
    } catch {
      return res.status(401).json({ success: false, error: 'invalid_or_expired_token' });
    }
  };
}
