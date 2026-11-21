'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  FIREBASE_AUTH_UNAVAILABLE_CODES,
  FirebaseAuthUnavailableError,
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

// ── 503 con motivo concreto (el usuario veía solo el genérico) ──────────
// Certificado autofirmado SOLO para pruebas (CN=firebase-test, generado
// con openssl; su clave privada vive solo en este archivo de tests y no
// se usa en ningún entorno real).
const RETRY_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUQ3Hl96Ix/I1RYwyrQp5f8GeebxMwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNZmlyZWJhc2UtdGVzdDAeFw0yNjExMjEwMzAzMzVaFw0y
NzExMjEwMzAzMzVaMBgxFjAUBgNVBAMMDWZpcmViYXNlLXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCetlaCJQ36QrFL+c76JKmWc6CQmuGHIfFl
0gFKyv9qz6xhEajo8ofP1WAq8x6dWdJwXJVS6FbuB6OeStom1A7IXLe05lKNSp8J
A8H3oPzvRRhC6aRTilcR7E/Caga4lpQ063uLm43puCN+iDLiOl69ZpIuNFzwQ7wQ
q0S8XVESao3gxqbex3In31sgxHoR/r7bO8qVxx9j8T3jiefwhE7fAJ2E8H41TLWE
cCoXrdSERcBVEZiBmiUY5M0cOMm2GDEq6AXLnDtFa68fJH8cQTbaqVWU8l0305QA
PgejsWDYeYyCVU1x1XwCJ1YF4lDh9voiCExjD4Y/JHRXil1KZYmrAgMBAAGjUzBR
MB0GA1UdDgQWBBQUu8twsA8twVHOJqurFfnUgeECejAfBgNVHSMEGDAWgBQUu8tw
sA8twVHOJqurFfnUgeECejAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQBX+2M6BSmDK3J652m1aCbePqhtw26xX6cyNFprfGJTGUqPW7xK4K9+DuEM
TtjUOYtDgbqzunHZZrQPXcenOrgUKSP9lxRm9EhjeLNDs4moRuOIOTA+Hw9eGJ30
BUKqT++nYyeFDfHTn/PuXDQ5D42kHS7+7DA+HT4bldpIwlQfXH1kmy28CVhgB+O3
hHE5fQ8714SrAH+csRknn/LRH/1EwZX+BqhhhaJnEP9k66c6bFTOrihpt1i4BpV2
fzmsSEg3kUjJkpDCepTyP6p0oo0Z2DYsBOvBbcyUxN02C4rNSFfS+eA1VP/aG6XR
9MhnjAa60b/QaPJ92NDJd5LK7jlb
-----END CERTIFICATE-----`;
const RETRY_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCetlaCJQ36QrFL
+c76JKmWc6CQmuGHIfFl0gFKyv9qz6xhEajo8ofP1WAq8x6dWdJwXJVS6FbuB6Oe
Stom1A7IXLe05lKNSp8JA8H3oPzvRRhC6aRTilcR7E/Caga4lpQ063uLm43puCN+
iDLiOl69ZpIuNFzwQ7wQq0S8XVESao3gxqbex3In31sgxHoR/r7bO8qVxx9j8T3j
iefwhE7fAJ2E8H41TLWEcCoXrdSERcBVEZiBmiUY5M0cOMm2GDEq6AXLnDtFa68f
JH8cQTbaqVWU8l0305QAPgejsWDYeYyCVU1x1XwCJ1YF4lDh9voiCExjD4Y/JHRX
il1KZYmrAgMBAAECggEAKNNKaWvSrp9dL+fwX9Pyc6sGkGvmu3X1vHVKs8yH6xfE
haufQVyxprqCZEnphBxIz3JhTtRJGC2K3vruJrLBorSG5NeiQIoDYrQ+vs4AgiPJ
29xx0rNxNkENOzs+w1iogvxX6U94L7iYGMI8JIlTOXEbBRufFIa356nGopV2dz/d
wY250fd/i1fIPv0LYoGQFBk0uuLTFakula2YfJHR7sBL8E8UtAeBw5CA44ju29qq
rZW6UhmWnwc2HYQaNnpKuBmGieKwNnPJr3Wv8id9S/keFwEfR8o1uE1ve1eWsYzW
O+N3MDyHieVcuYSyACkGughIOxfuIgSqYoPZSrjhkQKBgQDQQBMAikVbeY972CBN
tiUqiE8wRI3Klw4iPfDPisSMGl89QVRcTGHy4tKaPCn6iyDUTAes1NKLIGFuE8CN
5Omw4D7KfP/a8Ulf7xO8AA5z6gfaI43MlNhOuKnXXGcNdzH8d5HYQBYh13UlS0f6
KYADzrT6gMA3EkpRqocyd7IC/QKBgQDDGnfjcSDY1QPrc3H+gUDFtn4J3quHJg2n
jfdlU1bhhoxB6ff1w2+EO3j8651TuE8CM9suOJxXeoFJ4jLPFDQaBoEKawzXAKSp
OEZ3uxwVGkN7YV5lMRjExUx0a4HQR68CvlqRt7B5QrTDMk4dLyuwReqYcjTtp1Pb
jwB/XkFDxwKBgESatyfYZVzrQP+VhZ7UQI4wdZX7H5L8DGXvbeORXYqiLXnqibYW
W7Y+Tw8Mfu/Q4bHOkkC3o9y9gBtZWnfkT7A7T7Q5Vbh1AK0f/6pRgnFhSdDtIYui
BVh5sUoHYNOozsjTQzKwehoP9sGgeUfKYCfg8vILdEcwOVeKDBvuHrCpAoGAWTn9
olLWhtPEmyWM+Kv8B2/SbIkdQQ2yKPLQNdLLZRC3jF2IPSlIEt1wE5tdtDASUhuN
HbJeLdOk1TlRq0q+GTjoQu96S8nLhGhsMc2spioAuqhpFzZA8ZyZvpR8JdjivQp5
OTMczhgnuy2Cc+5iuJcBFv8EHbvsqfjYbWeZyXkCgYEAlEUxnx2FxSNhepBCiJrq
zlS0XBxYjy9xgqhmE9xeFpKIiMBuI/knryvMIKKEZ57y8CLsisIYplxn0hF94dRx
QRmqAQsl9i/IP91XSJsH5VPM3aEzMpWhIZa5sKVivXkSCiW7gy/v+ObDC24gcIvQ
oY74YDXEzm4wmxELNAHLYxU=
-----END PRIVATE KEY-----`;
const RETRY_KEY_ID = 'retry-key-id';

function createRetryToken() {
  const header = { alg: 'RS256', typ: 'JWT', kid: RETRY_KEY_ID };
  const claims = {
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: 'retry-user',
    iat: nowSeconds - 30,
    auth_time: nowSeconds - 60,
    exp: nowSeconds + 3600,
  };
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const key = crypto.createPrivateKey(RETRY_PRIVATE_KEY_PEM);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

function certOkResponse(certPem) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'max-age=3600' },
    json: async () => ({ [RETRY_KEY_ID]: certPem }),
  };
}

test('sin FIREBASE_PROJECT_ID el 503 lleva el código de proyecto no configurado', async () => {
  const saved = process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_PROJECT_ID;
  try {
    const verify = createFirebaseTokenVerifier({
      now: () => FIXED_NOW_MS,
      certificateProvider: async () => certificates,
    });
    await assert.rejects(
      verify(createSignedToken()),
      (err) => {
        assert.ok(err instanceof FirebaseAuthUnavailableError);
        assert.equal(err.statusCode, 503);
        assert.equal(err.code, FIREBASE_AUTH_UNAVAILABLE_CODES.projectNotConfigured);
        assert.match(err.message, /FIREBASE_PROJECT_ID/);
        return true;
      },
    );
  } finally {
    if (saved === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = saved;
  }
});

test('si Google no responde, reintenta una vez y da 503 con código de claves inalcanzables', async () => {
  let calls = 0;
  const verify = createFirebaseTokenVerifier({
    projectId: PROJECT_ID,
    now: () => FIXED_NOW_MS,
    fetchImpl: async () => { calls++; throw new Error('red caída'); },
  });
  await assert.rejects(
    verify(createSignedToken()),
    (err) => {
      assert.ok(err instanceof FirebaseAuthUnavailableError);
      assert.equal(err.statusCode, 503);
      assert.equal(err.code, FIREBASE_AUTH_UNAVAILABLE_CODES.keysUnreachable);
      return true;
    },
  );
  assert.equal(calls, 2, 'un intento + un reintento');
});

test('el reintento recupera si Google responde a la segunda y el token valida', async () => {
  let calls = 0;
  const verify = createFirebaseTokenVerifier({
    projectId: PROJECT_ID,
    now: () => FIXED_NOW_MS,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new Error('red caída');
      return certOkResponse(RETRY_CERT_PEM);
    },
  });
  const claims = await verify(createRetryToken());
  assert.equal(claims.sub, 'retry-user');
  assert.equal(calls, 2);
});
