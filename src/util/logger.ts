const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

export interface Logger {
  step(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
  debug(message: string): void;
}

export interface LoggerOptions {
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const color = options.color ?? (process.stderr.isTTY === true && !process.env.NO_COLOR);
  const paint = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text);
  const out = (text: string) => {
    if (!options.quiet) process.stderr.write(`${text}\n`);
  };

  return {
    step: (m) => out(`${paint(DIM, '>')} ${m}`),
    info: (m) => out(`  ${m}`),
    warn: (m) => out(`${paint(YELLOW, '!')} ${m}`),
    // Errors bypass `quiet` — a silenced run must still say why it failed.
    error: (m) => process.stderr.write(`${paint(RED, 'x')} ${m}\n`),
    success: (m) => out(`${paint(GREEN, 'v')} ${m}`),
    debug: (m) => {
      if (options.verbose && !options.quiet) process.stderr.write(`${paint(DIM, `  ${m}`)}\n`);
    },
  };
}

export const silentLogger: Logger = {
  step: () => {}, info: () => {}, warn: () => {},
  error: () => {}, success: () => {}, debug: () => {},
};
