const MIN_USER_MESSAGES = 3;
const MIN_USER_TEXT_CHARS = 40;
const MAX_USER_INPUT_CHARS = 1000;
const MAX_TITLE_CHARS = 80;
const MAX_ATTEMPTS = 2;

const TITLE_SYSTEM_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of a coding session. The title must be clear enough that the user recognizes the session in a list. Return only the title, with no quotes, markdown, or explanation.`;

export default function setupSessionAutoTitle(ctx, agentSessions, onTitleChanged) {
  const attempts = new Map();
  const inFlight = new Map();
  let disposed = false;

  const disposable = ctx.hooks.on(
    'turn:after',
    (event) => {
      if (event.hasError || event.input?.source === 'system' || disposed) return;
      const session = agentSessions.findByAgent(event.owner);
      if (
        !session ||
        session.sessionController.getCurrentTitle() !== null ||
        session.sessionController.hasManualTitle()
      )
        return;

      const sessionId = session.sessionController.getCurrentSessionId();
      if (inFlight.has(sessionId) || (attempts.get(sessionId) ?? 0) >= MAX_ATTEMPTS) return;

      const messages = session.uiState?.conversationMessages?.length
        ? session.uiState.conversationMessages
        : session.agent.toConversationMessages();
      const userTexts = messages.filter(isRealUserMessage).map((message) => contentToText(message.content).trim());
      if (userTexts.length < MIN_USER_MESSAGES || userTexts.join('').length < MIN_USER_TEXT_CHARS) return;

      const userInput = buildUserInput(messages);
      if (!userInput) return;

      attempts.set(sessionId, (attempts.get(sessionId) ?? 0) + 1);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const task = generateAndApplyTitle({
        session,
        sessionId,
        userInput,
        controller,
        isDisposed: () => disposed,
        onTitleChanged,
      })
        .catch((error) => {
          if (!controller.signal.aborted) {
            ctx.logger.warn('session_auto_title_failed', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          clearTimeout(timeout);
          inFlight.delete(sessionId);
        });
      inFlight.set(sessionId, { controller, task });
    },
    { pluginId: ctx.pluginId, priority: 50 },
  );

  ctx.onDispose(async () => {
    disposed = true;
    disposable.dispose();
    const tasks = [...inFlight.values()];
    for (const item of tasks) item.controller.abort();
    await Promise.allSettled(tasks.map((item) => item.task));
  });
}

async function generateAndApplyTitle({ session, sessionId, userInput, controller, isDisposed, onTitleChanged }) {
  const subAgent = session.agent.createSubAgent({
    systemPrompt: TITLE_SYSTEM_PROMPT,
    effort: 'none',
    tools: false,
  });
  const response = await subAgent.query(userInput, { signal: controller.signal, maxTurns: 1 });
  const title = normalizeGeneratedTitle(response);
  if (!title || isDisposed()) return;
  if (!session.sessionController.tryAutoRename(sessionId, title)) return;
  session.titleOverride = title;
  session.updatedAt = new Date().toISOString();
  onTitleChanged?.();
}

function buildUserInput(messages) {
  const text = messages
    .filter(isRealUserMessage)
    .map((message) => contentToText(message.content).trim())
    .join('\n\n');
  return text.slice(-MAX_USER_INPUT_CHARS);
}

function isRealUserMessage(message) {
  return (
    message?.role === 'user' && !isInternalCompactMessage(message) && contentToText(message.content).trim().length > 0
  );
}

function isInternalCompactMessage(message) {
  const text = contentToText(message?.content).trimStart();
  return text.startsWith('[Mica compact boundary]') || text.startsWith('[Mica compact checkpoint]');
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function normalizeGeneratedTitle(value) {
  if (typeof value !== 'string') return null;
  let title = value.trim();
  if (title.startsWith('{')) {
    try {
      const parsed = JSON.parse(title);
      title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
    } catch {
      // Fall through and sanitize the raw response.
    }
  }
  title = title
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .split(/\r?\n/, 1)[0]
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return null;
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS).trimEnd() : title;
}

export const sessionAutoTitleLimits = {
  minUserMessages: MIN_USER_MESSAGES,
  minUserTextChars: MIN_USER_TEXT_CHARS,
  maxUserInputChars: MAX_USER_INPUT_CHARS,
  maxAttempts: MAX_ATTEMPTS,
};
