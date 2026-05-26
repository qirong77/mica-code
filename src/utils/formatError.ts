export function formatError(error: unknown, maxLen = 2000): string {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : JSON.stringify(error);
  return message.length > maxLen ? `${message.slice(0, maxLen)}\n...(截断)` : message;
}
