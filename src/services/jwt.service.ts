import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export type Role = 'patient' | 'doctor';

export interface TokenPayload {
  sub: string; // globalPatientId for patients, doctor id for doctors
  role: Role;
}

export function signToken(payload: TokenPayload, expiresIn: string | number = '30d'): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, env.jwtSecret) as TokenPayload;
}
