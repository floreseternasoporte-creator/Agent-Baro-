'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  FirebaseTokenError,
  createFirebaseTokenVerifier,
} = require('../firebaseTokenVerifier');

const PROJECT_ID = 'firebase-test-project';
const FIXED_NOW_MS = 1_800_000_000_000;
const nowSeconds = Math.floor(FIXED_NOW_MS / 1000);
const signingKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const certificates = new Map([['test-key-id', signingKeyPair.publicKey]]);
const verifyFirebaseIdToken = createFirebaseTokenVerifier({
  projectId: PROJECT_ID,
  now: () => FIXED_NOW_MS,
  certificateProvider: async () => certificates,
});

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function createSignedToken(claimOverrides = {}, keyPair = signingKeyPair) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-id' };
  const claims = {
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: 'user-a',
    iat: nowSeconds - 30,
    auth_time: nowSeconds - 60,
    exp: nowSeconds + 3600,
    ...claimOverrides,
  };
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), keyPair.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

test('acepta un ID token Firebase firmado para el proyecto configurado', async () => {
  const claims = await verifyFirebaseIdToken(createSignedToken());

  assert.equal(claims.sub, 'user-a');
  assert.equal(claims.aud, PROJECT_ID);
});

test('rechaza un token Firebase expirado aunque su firma sea auténtica', async () => {
  const expiredToken = createSignedToken({ exp: nowSeconds - 1 });

  await assert.rejects(verifyFirebaseIdToken(expiredToken), FirebaseTokenError);
});

test('rechaza un token cuyo contenido fue alterado después de firmarse', async () => {
  const token = createSignedToken();
  const [header, , signature] = token.split('.');
  const alteredClaims = encodeJson({
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: 'user-b',
    iat: nowSeconds - 30,
    auth_time: nowSeconds - 60,
    exp: nowSeconds + 3600,
  });

  await assert.rejects(verifyFirebaseIdToken(`${header}.${alteredClaims}.${signature}`), FirebaseTokenError);
});

test('rechaza audiencia o emisor de otro proyecto Firebase', async () => {
  await assert.rejects(
    verifyFirebaseIdToken(createSignedToken({ aud: 'other-project' })),
    FirebaseTokenError,
  );
  await assert.rejects(
    verifyFirebaseIdToken(createSignedToken({ iss: 'https://securetoken.google.com/other-project' })),
    FirebaseTokenError,
  );
});

test('rechaza tokens mal formados antes de procesar certificados', async () => {
  await assert.rejects(verifyFirebaseIdToken('not-a-jwt'), FirebaseTokenError);
});
