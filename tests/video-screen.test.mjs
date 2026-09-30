import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref, computed } from 'vue';

const script = readFileSync(new URL('../app/pages/video-screen.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/import .* from 'vue';/, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function setup(options = {}) {
  let now = 0, unmount, mounted, micCalls = 0, displayCalls = 0;
  const tracks = [], instances = [], contexts = [], revoked = [], blobs = [], timers = new Set();
  function track(kind) {
    const listeners = {};
    const value = { kind, readyState: 'live', stop() { this.readyState = 'ended'; },
      addEventListener(name, fn) { listeners[name] = fn; },
      end() { this.stop(); listeners.ended?.(); }, getSettings: () => ({ displaySurface: 'browser' }) };
    tracks.push(value);
    return value;
  }
  class Stream {
    constructor(items) { this.items = items; }
    getTracks() { return this.items; }
    getVideoTracks() { return this.items.filter(item => item.kind === 'video'); }
    getAudioTracks() { return this.items.filter(item => item.kind === 'audio'); }
  }
  class Recorder {
    static isTypeSupported(type) { return options.supported !== false && type.startsWith('video/webm'); }
    constructor(stream, { mimeType }) { Object.assign(this, { stream, mimeType, state: 'inactive' }); instances.push(this); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['video'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  class AudioContext {
    constructor() { this.closed = false; this.sources = []; contexts.push(this); }
    createMediaStreamDestination() { return { stream: new Stream([track('audio')]) }; }
    createMediaStreamSource() {
      const source = { connected: false, connect() { this.connected = true; }, disconnect() { this.connected = false; } };
      this.sources.push(source); return source;
    }
    async resume() {}
    async close() { this.closed = true; }
  }
  const display = new Stream([track('video'), ...(options.audio === false ? [] : [track('audio')])]);
  const mic = new Stream([track('audio')]);
  const context = {
    ref, computed, onMounted: fn => { mounted = fn; }, onBeforeUnmount: fn => { unmount = fn; },
    window: { isSecureContext: options.secure !== false, MediaRecorder: Recorder, AudioContext },
    MediaRecorder: Recorder, MediaStream: Stream, Blob,
    performance: { now: () => now },
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:' + blobs.length; }, revokeObjectURL: url => revoked.push(url) },
    navigator: { mediaDevices: {
      async getDisplayMedia() { displayCalls++; if (options.displayError) throw options.displayError; return options.displayPending?.promise || display; },
      async getUserMedia() { micCalls++; if (options.micError) throw options.micError; return options.micPending?.promise || mic; },
    } },
  };
  runInNewContext(script + '\nthis.api = { state, systemAudio, microphone, duration, videoUrl, notice, errorMessage, supportError, startRecord, pauseRecord, resumeRecord, stopRecord };', context);
  mounted();
  return { ...context.api, display, mic, tracks, instances, contexts, revoked, blobs, timers,
    unmount: () => unmount(), advance: ms => { now += ms; timers.forEach(fn => fn()); },
    micCalls: () => micCalls, displayCalls: () => displayCalls };
}

test('record, pause, resume and stop exclude paused time and produce WebM', async () => {
  const app = setup();
  await app.startRecord();
  assert.equal(app.micCalls(), 0);
  app.advance(1250); app.pauseRecord(); app.advance(5000);
  assert.equal(app.duration.value, 1250);
  app.resumeRecord(); app.advance(850); app.stopRecord();
  assert.equal(app.state.value, 'stopping');
  await app.startRecord();
  assert.equal(app.displayCalls(), 1);
  await flush();
  assert.equal(app.duration.value, 2100);
  assert.equal(app.state.value, 'idle');
  assert.match(app.blobs[0].type, /^video\/webm/);
  assert.ok(app.display.getTracks().every(track => track.readyState === 'ended'));
  app.unmount();
  assert.deepEqual(app.revoked, ['blob:1']);
});

test('system audio and microphone are mixed into one audio track and released', async () => {
  const app = setup(); app.microphone.value = true;
  await app.startRecord();
  assert.equal(app.micCalls(), 1);
  assert.equal(app.instances[0].stream.getAudioTracks().length, 1);
  assert.equal(app.contexts[0].sources.length, 2);
  app.pauseRecord(); app.display.getVideoTracks()[0].end(); await flush();
  assert.equal(app.state.value, 'idle');
  assert.ok(app.contexts[0].closed);
  assert.ok(app.tracks.every(track => track.readyState === 'ended'));
  assert.ok(app.contexts[0].sources.every(source => !source.connected));
});

test('missing shared audio warns; disabled audio yields video only', async () => {
  const app = setup({ audio: false }); await app.startRecord();
  assert.match(app.notice.value, /未获取到/); app.unmount();
  const silent = setup(); silent.systemAudio.value = false; await silent.startRecord();
  assert.equal(silent.instances[0].stream.getAudioTracks().length, 0); silent.unmount();
});

test('denied microphone releases screen and returns to idle', async () => {
  const app = setup({ micError: { name: 'NotAllowedError' } }); app.microphone.value = true;
  await app.startRecord();
  assert.equal(app.state.value, 'idle');
  assert.match(app.errorMessage.value, /麦克风授权/);
  assert.ok(app.display.getTracks().every(track => track.readyState === 'ended'));
});

test('cancelled sharing preserves previous preview', async () => {
  const options = {}; const app = setup(options);
  await app.startRecord(); app.stopRecord(); await flush();
  options.displayError = { name: 'NotAllowedError' }; await app.startRecord();
  assert.equal(app.videoUrl.value, 'blob:1'); assert.equal(app.revoked.length, 0); app.unmount();
});

test('double start is ignored and late screen permission after unmount is released', async () => {
  const displayPending = deferred(); const app = setup({ displayPending });
  const starting = app.startRecord(); await app.startRecord();
  assert.equal(app.displayCalls(), 1);
  app.unmount(); displayPending.resolve(app.display); await starting;
  assert.ok(app.display.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(app.instances.length, 0);
});

test('sharing ended while microphone permission is pending releases late microphone', async () => {
  const micPending = deferred(); const app = setup({ micPending }); app.microphone.value = true;
  const starting = app.startRecord(); await flush();
  app.display.getVideoTracks()[0].end(); micPending.resolve(app.mic); await starting;
  assert.equal(app.state.value, 'idle');
  assert.ok(app.tracks.every(track => track.readyState === 'ended'));
  assert.equal(app.instances.length, 0);
});

test('unmount during recording creates no preview or timer leak', async () => {
  const app = setup(); await app.startRecord(); app.unmount(); await flush();
  assert.equal(app.blobs.length, 0); assert.equal(app.timers.size, 0);
});

test('unsupported WebM and insecure context block capture', async () => {
  for (const options of [{ supported: false }, { secure: false }]) {
    const app = setup(options); await app.startRecord();
    assert.ok(app.supportError.value); assert.equal(app.displayCalls(), 0);
  }
});
