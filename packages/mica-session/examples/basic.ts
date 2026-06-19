import { micaSession } from '../index.js';

const store = micaSession.createStore();
const sessions = store.list(5);
console.log(`recent sessions: ${sessions.length}`);
