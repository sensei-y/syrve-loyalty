import { BadRequestException } from '@nestjs/common';
import { SyrveIdPipe } from './syrve-id.pipe';

describe('SyrveIdPipe', () => {
  const pipe = new SyrveIdPipe();

  it('приводить id до нижнього регістру', () => {
    expect(pipe.transform('0EAA0000-29B3-B8CB-ABC4-08DF3E60AF1E')).toBe('0eaa0000-29b3-b8cb-abc4-08df3e60af1e');
  });

  it('невірний формат → 400', () => {
    expect(() => pipe.transform('not-an-id')).toThrow(BadRequestException);
  });
});
