/**
 * Context-aware console.log wrapper
 * Adds file, function, and line number context
 * Delegates to the structured logger, which writes to the console
 */

import { logger } from "./logger.ts";

interface LogContext {
  file?: string;
  function?: string;
  line?: number;
  column?: number;
}

/**
 * Extract context from stack trace
 */
function extractContext(stackDepth: number = 3): LogContext {
  try {
    const stack = new Error().stack;
    if (!stack) {
      return {};
    }

    const lines = stack.split("\n");
    // Skip Error line, this function, and the wrapper function
    const targetLine = lines[stackDepth];
    if (!targetLine) {
      return {};
    }

    // Match patterns like:
    // "    at functionName (file:///path/to/file.ts:123:45)"
    // "    at file:///path/to/file.ts:123:45"
    const match = targetLine.match(/at\s+(?:(\w+)\s+\()?([^\s]+):(\d+):(\d+)\)?/);
    if (match) {
      const [, functionName, filePath, line, column] = match;
      
      // Extract just the filename from the path
      const fileName = filePath.split("/").pop() || filePath;
      
      return {
        function: functionName || undefined,
        file: fileName,
        line: parseInt(line, 10),
        column: parseInt(column, 10),
      };
    }
  } catch {
    // Silently fail if stack trace parsing fails
  }
  
  return {};
}

/**
 * Format log message with context
 */
function formatMessage(message: string, context: LogContext): string {
  const parts: string[] = [];
  
  if (context.file) {
    parts.push(`[${context.file}`);
    if (context.line) {
      parts.push(`:${context.line}`);
    }
    parts.push("]");
  }
  
  if (context.function) {
    parts.push(`[${context.function}]`);
  }
  
  if (parts.length > 0) {
    return `${parts.join(" ")} ${message}`;
  }
  
  return message;
}

/**
 * Context-aware console.log wrapper
 *
 * Usage:
 *   import { log } from "./context-logger.ts";
 *   log("My message", { data: "value" });
 *
 * This will:
 * 1. Extract file, function, and line number from stack trace
 * 2. Send to structured logger (outputs to console)
 */
export function log(message: string, ...args: unknown[]): void {
  const context = extractContext();
  const formattedMessage = formatMessage(message, context);

  // Parse args to extract structured data
  let metadata: Record<string, unknown> | undefined;

  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    // Single object argument - use as metadata
    metadata = args[0] as Record<string, unknown>;
  } else if (args.length > 0) {
    // Multiple arguments - create metadata object
    metadata = {
      args: args.length === 1 ? args[0] : args,
    };
  }

  // Add context to metadata
  const enrichedMetadata: Record<string, unknown> = {
    ...metadata,
    log_context: {
      file: context.file,
      function: context.function,
      line: context.line,
      column: context.column,
    },
    original_message: message,
  };

  // Send to structured logger (outputs to console)
  logger.info(formattedMessage, enrichedMetadata);
}

/**
 * Context-aware console.error wrapper
 */
export function logError(message: string, ...args: unknown[]): void {
  const context = extractContext();
  const formattedMessage = formatMessage(message, context);

  let metadata: Record<string, unknown> | undefined;

  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    metadata = args[0] as Record<string, unknown>;
  } else if (args.length > 0) {
    metadata = {
      args: args.length === 1 ? args[0] : args,
    };
  }

  const enrichedMetadata: Record<string, unknown> = {
    ...metadata,
    log_context: {
      file: context.file,
      function: context.function,
      line: context.line,
      column: context.column,
    },
    original_message: message,
  };

  logger.error(formattedMessage, enrichedMetadata);
}

/**
 * Context-aware console.warn wrapper
 */
export function logWarn(message: string, ...args: unknown[]): void {
  const context = extractContext();
  const formattedMessage = formatMessage(message, context);

  let metadata: Record<string, unknown> | undefined;

  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    metadata = args[0] as Record<string, unknown>;
  } else if (args.length > 0) {
    metadata = {
      args: args.length === 1 ? args[0] : args,
    };
  }

  const enrichedMetadata: Record<string, unknown> = {
    ...metadata,
    log_context: {
      file: context.file,
      function: context.function,
      line: context.line,
      column: context.column,
    },
    original_message: message,
  };

  logger.warn(formattedMessage, enrichedMetadata);
}

/**
 * Context-aware console.debug wrapper
 */
export function logDebug(message: string, ...args: unknown[]): void {
  const context = extractContext();
  const formattedMessage = formatMessage(message, context);

  let metadata: Record<string, unknown> | undefined;

  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    metadata = args[0] as Record<string, unknown>;
  } else if (args.length > 0) {
    metadata = {
      args: args.length === 1 ? args[0] : args,
    };
  }

  const enrichedMetadata: Record<string, unknown> = {
    ...metadata,
    log_context: {
      file: context.file,
      function: context.function,
      line: context.line,
      column: context.column,
    },
    original_message: message,
  };

  logger.debug(formattedMessage, enrichedMetadata);
}

