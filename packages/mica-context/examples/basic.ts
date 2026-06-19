import { micaContext } from '../index.js';

const result = await new micaContext.CompactionService().compact({
  messages: [
    { role: 'user', content: 'Please inspect src/index.ts' },
    { role: 'assistant', content: 'I will inspect the entrypoint.' },
    { role: 'tool', name: 'read_file', content: 'src/index.ts contents...' },
    { role: 'assistant', content: 'The app starts through createApplication().' },
  ],
  summarize: async () => [
    '## User Intent',
    'Understand the app entrypoint.',
    '## Current State',
    'The app starts through createApplication().',
    '## Immediate Next Step',
    'Continue implementation.',
  ].join('\n'),
});

console.log(result.summary);
