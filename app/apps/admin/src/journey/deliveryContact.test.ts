import { describe, it, expect } from 'vitest';
import { deliveryContactError } from './deliveryContact';

describe('a report-delivery choice needs a way to deliver (QA E14)', () => {
  it('email needs a valid address', () => {
    expect(deliveryContactError('email', '', '')).toMatch(/email address/);
    expect(deliveryContactError('email', 'not-an-email', '')).not.toBeNull();
    expect(deliveryContactError('email', ' ada@example.com ', '')).toBeNull();
  });

  it('text needs a mobile number', () => {
    expect(deliveryContactError('text', 'ada@example.com', '')).toMatch(/mobile number/);
    expect(deliveryContactError('text', '', '12')).not.toBeNull();
    expect(deliveryContactError('text', '', '0803 123 4567')).toBeNull();
  });

  it('no report needs nothing', () => {
    expect(deliveryContactError('none', '', '')).toBeNull();
  });
});
