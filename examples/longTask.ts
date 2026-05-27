
import '../src/index'
import { messagesAtom } from '../src/store/conversation.js';
messagesAtom.set([{ role: 'user', content: '帮我测试 agent 的运行长任务的效果，请你执行一个 Tool 且需要耗费 CPU 的操作，例如用递归计算 F(42) 的值' }]);