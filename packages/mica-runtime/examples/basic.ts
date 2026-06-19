import { micaRuntime } from '../index.js';

const events = new micaRuntime.RuntimeEventBus();
events.on('event', (event) => console.log(event.type));

const input = micaRuntime.createRuntimeInput('hello runtime');
const queue = new micaRuntime.MessageQueueService();
queue.enqueue(input);
events.publish({ type: 'queue:changed', pendingInputs: queue.list() });
