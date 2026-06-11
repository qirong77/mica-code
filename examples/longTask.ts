import '../src/index';
import { MicaAgent } from '../src/core/agent.js';

setTimeout(() => {
  MicaAgent.ui.TerminalInput.submit(
    '帮我测试 agent 运行长任务的效果，请你执行一个需要耗费 CPU 的操作，例如用递归计算 fibonacci(42) 的值',
  );
}, 500);