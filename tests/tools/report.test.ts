import { describe, expect, it } from 'vitest';
import { reportPath } from '../../tools/vite-plugin-report';

describe('the report endpoint', () => {
  it('takes a run and a report or screenshot name', () => {
    expect(reportPath('/safari/report.json')).toEqual({ run: 'safari', file: 'report.json' });
    expect(reportPath('/chrome-e2e/bay-dusk.png')).toEqual({ run: 'chrome-e2e', file: 'bay-dusk.png' });
  });
  it('refuses anything that could write outside its run', () => {
    for (const url of ['/../x/report.json', '/safari/../../etc.json', '/safari/sub/report.json', '/Safari/report.json', '/safari/report.js', '/safari/.json', '/safari', '', '/a b/report.json']) {
      expect(reportPath(url), url).toBeNull();
    }
  });
});
