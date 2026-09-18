export const isDebugLogging = import.meta.env.DEV;

export const debugLog = (...args: unknown[]) => {
  if (!isDebugLogging) return;
  console.log(...args);
};

