// Reproduce el hallazgo de la revisión: auth-service emite el claim "role" (ver
// TokenService.accessToken en festa-auth-service), no "accountType". Si este middleware
// leyera el claim equivocado, req.auth.accountType quedaría undefined para TODO usuario,
// y un merchant real nunca podría crear un evento con boletería (bloquea el camino principal).
import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { jwtPrivateKeyPem } from '../fixtures/jwtKeys.js';
import { requireAuth } from '../../src/middleware/auth.js';

function sign(claims) {
  return jwt.sign(claims, jwtPrivateKeyPem, {
    algorithm: 'RS256',
    issuer: process.env.JWT_ISSUER,
    subject: claims.sub ?? '550e8400-e29b-41d4-a716-446655440000',
    expiresIn: '15m',
  });
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('requireAuth', () => {
  it('expone en req.auth.accountType el claim "role" del token (merchant)', () => {
    const token = sign({ email: 'cafe@bohemio.co', role: 'merchant' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.auth.accountType).toBe('merchant');
  });

  it('expone "user" igual', () => {
    const token = sign({ email: 'persona@festa.co', role: 'user' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(req.auth.accountType).toBe('user');
  });

  it('rechaza sin header Authorization', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rechaza un token firmado con otra llave', () => {
    const token = jwt.sign({ role: 'merchant' }, 'otra-llave-cualquiera', {
      algorithm: 'HS256',
      issuer: process.env.JWT_ISSUER,
    });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
