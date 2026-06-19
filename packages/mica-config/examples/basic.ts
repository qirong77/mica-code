import { micaConfig } from '../index.js';

const config = micaConfig.get();
console.log(`provider=${config.provider} model=${config.model}`);
