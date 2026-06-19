import { micaCommon } from '../index.js';

const id = micaCommon.createId('example');
const store = new micaCommon.DisposableStore();
const events = new micaCommon.TypedEventBus<{ message: string }>();

store.add(events.on('message', (message) => console.log('event:', message)));
events.emit('message', id);
await store.dispose();
