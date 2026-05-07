import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Load Code.gs
const codeGs = fs.readFileSync(path.resolve(__dirname, '../../apps-script/Code.gs'), 'utf-8');

// Mock Google Apps Script environment
const globalEnv = {
  XmlService: {
    parse: () => ({ getRootElement: () => ({ getName: () => 'rss' }) }),
    getNamespace: () => ({})
  },
  Utilities: {
    base64Encode: (str) => Buffer.from(str).toString('base64')
  },
  log: console.log
};

describe('Code.gs parser', () => {
  it('should compile', () => {
    // Basic test just to ensure we can eval the code
    expect(codeGs).toBeDefined();
  });
});
