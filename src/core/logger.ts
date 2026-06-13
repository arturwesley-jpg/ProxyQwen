import pino, { Logger as PinoLogger, Level, LogDescriptor } from 'pino';
import { config } from './config.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Logger {
  trace(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  fatal(message: string, data?: Record<string, unknown>): void;
  child(context: string): Logger;
}

class PinoWrapper implements Logger {
  private logger: PinoLogger;

  constructor() {
    const isProduction = process.env.NODE_ENV === 'production';
    const logLevel = (process.env.LOG_LEVEL || 'info') as Level;

    const transportTargets: Array<{
      target: string;
      level: string;
      options: { destination: number | string; colorize?: boolean; translateTime?: string; ignore?: string; mkdir?: boolean };
    }> = [
      {
        target: 'pino/file',
        level: logLevel,
        options: {
          destination: 1, // stdout
          colorize: !isProduction,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    ];

    // Add file transport for production
    if (isProduction) {
      transportTargets.push({
        target: 'pino/file',
        level: 'info',
        options: {
          destination: './logs/app.log',
          mkdir: true,
        },
      });
      transportTargets.push({
        target: 'pino/file',
        level: 'error',
        options: {
          destination: './logs/error.log',
          mkdir: true,
        },
      });
    }

    this.logger = pino({
      level: logLevel,
      formatters: {
        level: (label) => ({ level: label }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      base: {
        service: 'qwenproxy',
        version: process.env.npm_package_version || '1.3.0',
      },
    }, pino.transport({ targets: transportTargets }));
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const logObj: LogDescriptor = { msg: message };
    if (data) Object.assign(logObj, data);
    this.logger[level](logObj);
  }

  trace(message: string, data?: Record<string, unknown>): void { this.log('trace', message, data); }
  debug(message: string, data?: Record<string, unknown>): void { this.log('debug', message, data); }
  info(message: string, data?: Record<string, unknown>): void { this.log('info', message, data); }
  warn(message: string, data?: Record<string, unknown>): void { this.log('warn', message, data); }
  error(message: string, data?: Record<string, unknown>): void { this.log('error', message, data); }
  fatal(message: string, data?: Record<string, unknown>): void { this.log('fatal', message, data); }

  child(context: string): Logger {
    const childLogger = this.logger.child({ context });
    const wrapper = Object.create(PinoWrapper.prototype);
    wrapper.logger = childLogger;
    return wrapper;
  }

  getPino(): PinoLogger {
    return this.logger;
  }
}

export const logger = new PinoWrapper();

// Backwards compatibility
export function createLogger(level: LogLevel = 'info', context?: string): Logger {
  return logger.child(context || '');
}
