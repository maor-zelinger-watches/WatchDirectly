import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Extract the parsing logic from Code.gs
const codeGs = fs.readFileSync(path.resolve(__dirname, '../../../apps-script/Code.gs'), 'utf-8');

// Use a simple regex to extract functions for testing
function extractFunction(name) {
  const match = codeGs.match(new RegExp(`function ${name}\\s*\\([^{]*\\)\\s*{([\\s\\S]*?\\n})`, 'm'));
  return match ? `function ${name}${match[0].substring(match[0].indexOf('('))}` : '';
}

const extractYouTubeIdCode = extractFunction('extractYouTubeId');

// Create a testable module string
const moduleStr = `
  ${extractYouTubeIdCode}
  
  // Expose
  module.exports = {
    extractYouTubeId
  };
`;

const backend = eval(`
  (function() {
    var module = { exports: {} };
    ${moduleStr}
    return module.exports;
  })()
`);

describe('Backend parsers', () => {
  describe('extractYouTubeId', () => {
    it('should extract standard youtube ids', () => {
      expect(backend.extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('should extract shorts ids (BUG)', () => {
      // This test is designed to fail if the bug exists
      expect(backend.extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });
  });
  
  describe('Article ID generation (BUG)', () => {
    it('should generate unique IDs for different articles', () => {
      const link1 = 'https://www.hodinkee.com/articles/watch-1';
      const link2 = 'https://www.hodinkee.com/articles/watch-2';
      
      const b64_1 = Buffer.from(link1).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(-15);
      const b64_2 = Buffer.from(link2).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(-15);
      
      // This test is designed to fail if the bug exists
      expect(b64_1).not.toBe(b64_2);
    });
  });
});
