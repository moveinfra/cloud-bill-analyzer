import { readFileSync } from 'node:fs';
import { analyzeText } from '../src/core/analyze';

export const sample = (name: string) => readFileSync(new URL(`../samples/${name}`, import.meta.url), 'utf8');
export const agg = (name: string) => analyzeText(sample(name));
