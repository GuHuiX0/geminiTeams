import { Runtime, Store } from '../../src/index.js';
const store = new Store(process.argv[2]!);
const runtime = new Runtime(store, { execute: () => new Promise(() => {}) });
store.onEvent(event => { if (event.kind === 'job.started') process.stdout.write(JSON.stringify({ taskId: event.taskId }) + '\n'); });
runtime.start(); runtime.submit({ intent: 'Survive a real process crash', policy: 'deep' });
