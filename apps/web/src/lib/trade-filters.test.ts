import { describe, expect, it } from 'vitest';

import { tradeFilterHref } from './trade-filters';

describe('trade objective navigation', () => {
  it('builds a shareable win-now URL while preserving the active target', () => {
    expect(
      tradeFilterHref(
        '/league/123/trades',
        new URLSearchParams('target=456'),
        'objective',
        'winNow',
      ),
    ).toBe('/league/123/trades?target=456&objective=winNow');
  });
});
