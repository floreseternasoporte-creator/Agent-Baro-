'use strict';
// @ts-check

const { verifyFirebaseIdToken } = require('./firebaseTokenVerifier');

const BEARER_TOKEN_PATTERN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/**
 * @typedef {Object} FirebaseAuthRequest
 * @property {string} method
 * @property {string} path
 * @property {(name: string) => string | undefined} get
 * @property {Readonly<{uid: string}>} [auth]
 */
/**
 * @typedef {Object} FirebaseAuthResponse
 * @property {boolean} headersSent
 * @property {(status: number) => {json: (body: Record<string, string>) => unknown}} status
 */
/** @typedef {(error?: unknown) => void} FirebaseAuthNext */

/**
 * @param {(token: string) => Promise<Record<string, unknown>>} [verifyIdToken]
 * @returns {(req: FirebaseAuthRequest, res: FirebaseAuthResponse, next: FirebaseAuthNext) => void}
 */
function createFirebaseAuthMiddleware(verifyIdToken = verifyFirebaseIdToken) {
  return function firebaseAuthMiddleware(req, res, next) {
    // Express CORS puede gestionar preflight antes de llegar aquí. Esta
    // excepción también evita bloquear OPTIONS en despliegues con otro CORS.
    if (req.method === 'OPTIONS' || req.path === '/health') return next();

    const authorization = req.get('authorization') || '';
    const match = BEARER_TOKEN_PATTERN.exec(authorization);
    if (!match) {
      return res.status(401).json({ error: 'Se requiere un token Firebase Bearer válido.' });
    }

    Promise.resolve(verifyIdToken(match[1]))
      .then((claims) => {
        if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
          return res.status(401).json({ error: 'Token Firebase inválido o expirado.' });
        }
        Object.defineProperty(req, 'auth', {
          value: Object.freeze({ uid: claims.sub }),
          enumerable: true,
          writable: false,
          configurable: false,
        });
        return next();
      })
      .catch((error) => {
        if (res.headersSent) return undefined;
        if (error && error.statusCode === 503) {
          return res.status(503).json({ error: 'La validación de Firebase no está disponible.' });
        }
        return res.status(401).json({ error: 'Token Firebase inválido o expirado.' });
      });
  };
}

module.exports = { createFirebaseAuthMiddleware };
