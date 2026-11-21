'use strict';
// @ts-check

const crypto = require('node:crypto');

const FIREBASE_CERTIFICATES_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const CERTIFICATE_FETCH_TIMEOUT_MS = 5000;
const CERTIFICATE_FETCH_ATTEMPTS = 2;
const CERTIFICATE_FETCH_RETRY_DELAY_MS = 500;
const DEFAULT_CERTIFICATE_CACHE_MS = 60 * 60 * 1000;
const MAX_CERTIFICATE_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_ID_TOKEN_LENGTH = 8192;
const MAX_FIREBASE_UID_LENGTH = 128;
const CLOCK_SKEW_SECONDS = 60;
const MAX_ID_TOKEN_LIFETIME_SECONDS = 60 * 60 + CLOCK_SKEW_SECONDS;

// Códigos del 503 de validación: distinguen la causa real para que
// el mensaje que ve el usuario sea concreto y accionable.
// - projectNotConfigured: falta FIREBASE_PROJECT_ID en el servidor
//   (Railway). No se arregla reintentando: hay que poner la variable.
// - keysUnreachable: Google no respondió al pedir las claves públicas
//   (red, timeout o 5xx). Transitorio: se reintenta una vez.
// - keysInvalid: Google respondió, pero sin claves utilizables.
const FIREBASE_AUTH_UNAVAILABLE_CODES = Object.freeze({
  projectNotConfigured: 'firebase_project_not_configured',
  keysUnreachable: 'firebase_keys_unreachable',
  keysInvalid: 'firebase_keys_invalid',
});

/**
 * La validación está configurada cuando el proyecto Firebase está
 * puesto en el entorno del servidor. Misma regla que usa el
 * verificador; server.js la reutiliza para el aviso de arranque
 * y para /api/health.
 *
 * @param {string | undefined} [projectId]
 * @returns {boolean}
 */
function isFirebaseAuthConfigured(projectId = process.env.FIREBASE_PROJECT_ID) {
  return typeof projectId === 'string' && projectId.trim() !== '';
}

class FirebaseTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FirebaseTokenError';
    this.statusCode = 401;
  }
}

class FirebaseAuthUnavailableError extends Error {
  constructor(message, code = 'firebase_auth_unavailable') {
    super(message);
    this.name = 'FirebaseAuthUnavailableError';
    this.statusCode = 503;
    this.code = code;
  }
}

/**
 * @typedef {Object} FirebaseTokenVerifierOptions
 * @property {string} [projectId]
 * @property {typeof fetch} [fetchImpl]
 * @property {() => number} [now]
 * @property {(forceRefresh?: boolean) => Promise<Map<string, import('node:crypto').KeyObject>>} [certificateProvider]
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function parseJsonObject(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new FirebaseTokenError('Token de Firebase mal formado.');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object');
    }
    return parsed;
  } catch {
    throw new FirebaseTokenError('Token de Firebase mal formado.');
  }
}

/**
 * @param {Headers | { get(name: string): string | null }} headers
 * @returns {number}
 */
function certificateCacheDuration(headers) {
  const cacheControl = headers.get('cache-control') || '';
  const match = /(?:^|,\s*)max-age=(\d+)/i.exec(cacheControl);
  if (!match) return DEFAULT_CERTIFICATE_CACHE_MS;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return DEFAULT_CERTIFICATE_CACHE_MS;
  return Math.min(seconds * 1000, MAX_CERTIFICATE_CACHE_MS);
}

/**
 * @param {typeof fetch | undefined} fetchImpl
 * @param {() => number} now
 * @returns {(forceRefresh?: boolean) => Promise<Map<string, import('node:crypto').KeyObject>>}
 */
function createCertificateProvider(fetchImpl, now) {
  /** @type {Map<string, import('node:crypto').KeyObject> | null} */
  let cachedKeys = null;
  let cacheExpiresAt = 0;
  /** @type {Promise<Map<string, import('node:crypto').KeyObject>> | null} */
  let pendingFetch = null;

  return async function loadCertificates(forceRefresh = false) {
    if (!forceRefresh && cachedKeys && now() < cacheExpiresAt) return cachedKeys;
    if (pendingFetch) return pendingFetch;
    if (typeof fetchImpl !== 'function') {
      throw new FirebaseAuthUnavailableError('No hay un cliente HTTP para validar Firebase.');
    }

    pendingFetch = (async () => {
      // Un fallo transitorio de red (o un 5xx de Google) no debería
      // tumbar la validación: se reintenta UNA vez con 500 ms de
      // espera. Un 4xx no se reintenta (no se arregla solo) y un
      // JSON ilegible tampoco. La firma RS256 y las claims se
      // verifican igual después: el reintento no relaja nada.
      let response;
      for (let attempt = 0; attempt < CERTIFICATE_FETCH_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, CERTIFICATE_FETCH_RETRY_DELAY_MS));
        try {
          response = await fetchImpl(FIREBASE_CERTIFICATES_URL, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(CERTIFICATE_FETCH_TIMEOUT_MS),
          });
        } catch {
          if (attempt === CERTIFICATE_FETCH_ATTEMPTS - 1) {
            throw new FirebaseAuthUnavailableError(
              'No se pudo contactar con el servicio de inicio de sesión para comprobar tu identidad. Vuelve a intentarlo en unos minutos.',
              FIREBASE_AUTH_UNAVAILABLE_CODES.keysUnreachable,
            );
          }
          continue;
        }
        if (response.ok) break;
        if (response.status < 500) {
          throw new FirebaseAuthUnavailableError(
            'No se pudo contactar con el servicio de inicio de sesión para comprobar tu identidad. Vuelve a intentarlo en unos minutos.',
            FIREBASE_AUTH_UNAVAILABLE_CODES.keysUnreachable,
          );
        }
        if (attempt === CERTIFICATE_FETCH_ATTEMPTS - 1) {
          throw new FirebaseAuthUnavailableError(
            'No se pudo contactar con el servicio de inicio de sesión para comprobar tu identidad. Vuelve a intentarlo en unos minutos.',
            FIREBASE_AUTH_UNAVAILABLE_CODES.keysUnreachable,
          );
        }
      }

      let certificateData;
      try {
        certificateData = await response.json();
      } catch {
        throw new FirebaseAuthUnavailableError(
          'El servicio de inicio de sesión devolvió datos que no se pueden usar para comprobar tu identidad. Vuelve a intentarlo en unos minutos.',
          FIREBASE_AUTH_UNAVAILABLE_CODES.keysInvalid,
        );
      }
      if (!certificateData || typeof certificateData !== 'object' || Array.isArray(certificateData)) {
        throw new FirebaseAuthUnavailableError(
          'El servicio de inicio de sesión devolvió datos que no se pueden usar para comprobar tu identidad. Vuelve a intentarlo en unos minutos.',
          FIREBASE_AUTH_UNAVAILABLE_CODES.keysInvalid,
        );
      }

      const keys = new Map();
      for (const [keyId, certificate] of Object.entries(certificateData)) {
        if (!keyId || typeof certificate !== 'string') continue;
        try {
          keys.set(keyId, new crypto.X509Certificate(certificate).publicKey);
        } catch {
          // Una entrada inválida no debe impedir usar las demás claves publicadas.
        }
      }
      if (keys.size === 0) {
        throw new FirebaseAuthUnavailableError(
          'El servicio de inicio de sesión devolvió datos que no se pueden usar para comprobar tu identidad. Vuelve a intentarlo en unos minutos.',
          FIREBASE_AUTH_UNAVAILABLE_CODES.keysInvalid,
        );
      }

      cachedKeys = keys;
      cacheExpiresAt = now() + certificateCacheDuration(response.headers);
      return keys;
    })();

    try {
      return await pendingFetch;
    } finally {
      pendingFetch = null;
    }
  };
}

/**
 * Crea un validador aislable en pruebas. En producción valida la firma RS256
 * contra los certificados HTTPS públicos de Firebase y comprueba las claims.
 *
 * @param {FirebaseTokenVerifierOptions} [options]
 * @returns {(token: string) => Promise<Record<string, unknown>>}
 */
function createFirebaseTokenVerifier(options = {}) {
  const now = options.now || Date.now;
  const loadCertificates = options.certificateProvider
    || createCertificateProvider(options.fetchImpl || globalThis.fetch, now);

  return async function verifyFirebaseIdToken(token) {
    const projectId = options.projectId || process.env.FIREBASE_PROJECT_ID;
    if (!isFirebaseAuthConfigured(projectId)) {
      throw new FirebaseAuthUnavailableError(
        'El inicio de sesión no está configurado en el servidor: falta la variable `FIREBASE_PROJECT_ID` en Railway (valor: ggggg-f2508). Añádela y vuelve a desplegar para que la app funcione.',
        FIREBASE_AUTH_UNAVAILABLE_CODES.projectNotConfigured,
      );
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_ID_TOKEN_LENGTH) {
      throw new FirebaseTokenError('Token de Firebase ausente o inválido.');
    }

    const segments = token.split('.');
    if (segments.length !== 3) throw new FirebaseTokenError('Token de Firebase mal formado.');
    const [encodedHeader, encodedClaims, encodedSignature] = segments;
    const header = parseJsonObject(encodedHeader);
    const claims = parseJsonObject(encodedClaims);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
      throw new FirebaseTokenError('Algoritmo o clave de Firebase inválidos.');
    }
    if (header.typ !== undefined && header.typ !== 'JWT') {
      throw new FirebaseTokenError('Tipo de token Firebase inválido.');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
      throw new FirebaseTokenError('Firma del token Firebase mal formada.');
    }

    let signingKeys = await loadCertificates(false);
    let signingKey = signingKeys.get(header.kid);
    if (!signingKey) {
      signingKeys = await loadCertificates(true);
      signingKey = signingKeys.get(header.kid);
    }
    if (!signingKey) throw new FirebaseTokenError('Clave de firma Firebase desconocida.');

    const signingInput = `${encodedHeader}.${encodedClaims}`;
    let signatureIsValid = false;
    try {
      signatureIsValid = crypto.verify(
        'RSA-SHA256',
        Buffer.from(signingInput, 'utf8'),
        signingKey,
        Buffer.from(encodedSignature, 'base64url'),
      );
    } catch {
      throw new FirebaseTokenError('No se pudo verificar la firma del token Firebase.');
    }
    if (!signatureIsValid) throw new FirebaseTokenError('Firma del token Firebase inválida.');

    const expectedIssuer = `https://securetoken.google.com/${projectId}`;
    if (claims.aud !== projectId || claims.iss !== expectedIssuer) {
      throw new FirebaseTokenError('El token no pertenece al proyecto Firebase esperado.');
    }
    if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > MAX_FIREBASE_UID_LENGTH) {
      throw new FirebaseTokenError('El token Firebase no contiene un UID válido.');
    }

    const currentTime = Math.floor(now() / 1000);
    const requiredTimes = ['exp', 'iat', 'auth_time'];
    for (const claimName of requiredTimes) {
      const value = claims[claimName];
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new FirebaseTokenError(`Claim Firebase ${claimName} inválida.`);
      }
    }
    if (claims.exp <= currentTime) throw new FirebaseTokenError('El token Firebase expiró.');
    if (claims.iat > currentTime + CLOCK_SKEW_SECONDS || claims.auth_time > currentTime + CLOCK_SKEW_SECONDS) {
      throw new FirebaseTokenError('El token Firebase tiene una fecha futura inválida.');
    }
    if (claims.auth_time > claims.iat + CLOCK_SKEW_SECONDS) {
      throw new FirebaseTokenError('La fecha de autenticación Firebase es inválida.');
    }
    if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_ID_TOKEN_LIFETIME_SECONDS) {
      throw new FirebaseTokenError('La vigencia del token Firebase es inválida.');
    }
    if (claims.nbf !== undefined && (
      typeof claims.nbf !== 'number'
      || !Number.isSafeInteger(claims.nbf)
      || claims.nbf > currentTime + CLOCK_SKEW_SECONDS
    )) {
      throw new FirebaseTokenError('El token Firebase aún no es válido.');
    }
    return claims;
  };
}

const verifyFirebaseIdToken = createFirebaseTokenVerifier();

module.exports = {
  FIREBASE_AUTH_UNAVAILABLE_CODES,
  FirebaseAuthUnavailableError,
  FirebaseTokenError,
  createFirebaseTokenVerifier,
  isFirebaseAuthConfigured,
  verifyFirebaseIdToken,
};
