'use strict';

// Tests H2 (trabajos asíncronos): el almacén de jobs crea trabajos,
// persiste eventos, lista por usuario sin mezclar cuentas, cancela
// y marca como fallidos los trabajos que quedaron a medias al
// reiniciar el servidor. Sin red ni LLM.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const jobsStore = require('../jobsStore');

function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-jobs-'));
  jobsStore.setJobsRoot(dir);
  return dir;
}

test('createJob crea un trabajo en cola con id único y lo persiste', () => {
  const dir = freshRoot();
  const job = jobsStore.createJob('uid-1', 'sess-1', 'hola');
  assert.equal(job.status, 'queued');
  assert.equal(job.message, 'hola');
  assert.ok(job.id.length > 10);
  assert.ok(fs.existsSync(path.join(dir, `${job.id}.json`)));
  const again = jobsStore.getJob(job.id, 'uid-1');
  assert.equal(again.id, job.id);
  assert.equal(again.status, 'queued');
});

test('getJob no devuelve el trabajo a otro usuario', () => {
  freshRoot();
  const job = jobsStore.createJob('uid-1', 'sess-1', 'secreto');
  assert.equal(jobsStore.getJob(job.id, 'uid-2'), null);
  assert.equal(jobsStore.getJob(job.id).id, job.id);
});

test('appendEvent persiste y reenvía a los suscriptores en vivo', () => {
  const dir = freshRoot();
  const job = jobsStore.createJob('uid-1', 'sess-1', 'hola');
  const seen = [];
  const off = jobsStore.subscribe(job.id, (event, data) => seen.push([event, data]));
  jobsStore.appendEvent(job, 'log', { title: 'Leyendo…' });
  jobsStore.appendEvent(job, 'delta', { delta: 'Hola' });
  assert.equal(job.events.length, 2);
  assert.deepEqual(seen, [['log', { title: 'Leyendo…' }], ['delta', { delta: 'Hola' }]]);
  off();
  jobsStore.appendEvent(job, 'log', { title: 'después' });
  assert.equal(seen.length, 2);
  // Los eventos sobreviven en disco: releer el archivo del trabajo.
  const reloaded = JSON.parse(fs.readFileSync(path.join(dir, `${job.id}.json`), 'utf8'));
  assert.equal(reloaded.events.length, 3);
  assert.equal(reloaded.events[1].event, 'delta');
});

test('setStatus marca el resultado y el trabajo queda terminal', () => {
  freshRoot();
  const job = jobsStore.createJob('uid-1', 'sess-1', 'hola');
  jobsStore.setStatus(job, 'running');
  assert.equal(job.status, 'running');
  assert.equal(jobsStore.isTerminal(job.status), false);
  jobsStore.setStatus(job, 'done', { result: { text: 'listo', diffCount: 0 } });
  assert.equal(jobsStore.isTerminal(job.status), true);
  assert.equal(job.result.text, 'listo');
});

test('requestCancel aborta el controlador y no cancela un trabajo terminado', () => {
  freshRoot();
  const job = jobsStore.createJob('uid-1', 'sess-1', 'hola');
  const controller = new AbortController();
  jobsStore.attachAbortController(job, controller);
  jobsStore.setStatus(job, 'running');
  const cancelled = jobsStore.requestCancel(job.id, 'uid-1');
  assert.equal(cancelled.status, 'running'); // sigue running hasta que el corredor lo marque
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(controller.signal.aborted, true);
  jobsStore.detachAbortController(job);
  jobsStore.setStatus(job, 'done', { result: { text: 'x' } });
  assert.equal(jobsStore.requestCancel(job.id, 'uid-1').status, 'done');
});

test('requestCancel en cola lo marca cancelado sin arrancar', () => {
  freshRoot();
  const job = jobsStore.createJob('uid-1', 'sess-1', 'hola');
  const out = jobsStore.requestCancel(job.id, 'uid-1');
  assert.equal(out.status, 'cancelled');
  assert.equal(jobsStore.requestCancel(job.id, 'otro-uid'), null);
});

test('listJobs ordena por recientes y no mezcla usuarios', () => {
  freshRoot();
  jobsStore.createJob('uid-1', 'sess-1', 'primero');
  const second = jobsStore.createJob('uid-1', 'sess-1', 'segundo');
  jobsStore.createJob('uid-2', 'sess-9', 'de otro');
  const mine = jobsStore.listJobs('uid-1');
  assert.equal(mine.length, 2);
  assert.equal(mine[0].id, second.id);
  assert.equal(mine[0].message, 'segundo');
  assert.equal(mine[0].events, undefined); // el resumen no lleva el log entero
  assert.equal(jobsStore.listJobs('uid-2').length, 1);
});

test('sweepStaleJobs marca como fallidos los trabajos a medias del arranque anterior', () => {
  const dir = freshRoot();
  const job = jobsStore.createJob('uid-1', 'sess-1', 'hola');
  jobsStore.setStatus(job, 'running');
  // Simula un reinicio: el mapa en memoria se vacía, el disco queda.
  jobsStore.setJobsRoot(dir);
  jobsStore.sweepStaleJobs();
  const after = jobsStore.getJob(job.id, 'uid-1');
  assert.equal(after.status, 'failed');
  assert.match(after.error, /reinició/);
});
