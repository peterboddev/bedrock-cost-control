/**
 * Small interactive-prompt helpers shared by the CLI test tool, built on
 * Node's built-in `readline/promises` module (no extra CLI/prompt
 * dependency needed).
 */
import { createInterface } from 'readline/promises';

export interface Prompter {
  ask(question: string): Promise<string>;
  askWithDefault(question: string, defaultValue: string): Promise<string>;
  askNumber(question: string, defaultValue?: number): Promise<number>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): void;
}

export function createPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  async function ask(question: string): Promise<string> {
    const answer = await rl.question(question);
    return answer.trim();
  }

  async function askWithDefault(question: string, defaultValue: string): Promise<string> {
    const answer = await ask(`${question} [${defaultValue}]: `);
    return answer.length > 0 ? answer : defaultValue;
  }

  async function askNumber(question: string, defaultValue?: number): Promise<number> {
    const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : '';
    for (;;) {
      const answer = await ask(`${question}${suffix}: `);
      if (answer.length === 0 && defaultValue !== undefined) {
        return defaultValue;
      }
      const parsed = Number(answer);
      if (Number.isFinite(parsed) && !Number.isNaN(parsed)) {
        return parsed;
      }
      console.log(`  Please enter a valid number.`);
    }
  }

  async function confirm(question: string, defaultYes = true): Promise<boolean> {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = (await ask(`${question} (${hint}): `)).toLowerCase();
    if (answer.length === 0) {
      return defaultYes;
    }
    return answer === 'y' || answer === 'yes';
  }

  function close(): void {
    rl.close();
  }

  return { ask, askWithDefault, askNumber, confirm, close };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowLabel(): string {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}
