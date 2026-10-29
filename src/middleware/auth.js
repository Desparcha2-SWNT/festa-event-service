import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const publicKey = fs.readFileSync(config.jwtPublicKeyPath, 'utf8');

/**
 * El gateway (Kong) ya rechaza las peticiones sin un JWT válido antes de que lleguen aquí.
 * Esto solo decodifica el token para saber quién es el usuario (`req.auth`).
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return res.status(401).json({ error: 'falta el token' });

  try {
    const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: config.jwtIssuer });
    req.auth = { userId: claims.sub, email: claims.email, accountType: claims.accountType };
    next();
  } catch {
    res.status(401).json({ error: 'token inválido' });
  }
}
