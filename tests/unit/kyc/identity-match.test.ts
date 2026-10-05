import { describe, expect, it } from 'vitest';
import { matchIdentity, normalizeName } from '../../../src/modules/kyc/providers/identity-match.ts';
import type { IdentitySubject } from '../../../src/modules/kyc/providers/kyc-provider.ts';

const emma: IdentitySubject = {
  firstName: 'Emma',
  lastName: 'Okafor',
  dateOfBirth: '1995-04-12',
};

describe('normalizeName', () => {
  it('ignores case, accents, punctuation and extra spaces', () => {
    expect(normalizeName('  Chíọmá  Okafor-Eze ')).toBe('chioma okafor eze');
  });
});

describe('matchIdentity', () => {
  it('matches the same person regardless of case and accents', () => {
    expect(matchIdentity(emma, { ...emma, firstName: 'EMMÁ', lastName: 'okafor' })).toEqual([]);
  });

  it('matches when the record swaps first and last name', () => {
    expect(matchIdentity(emma, { ...emma, firstName: 'Okafor', lastName: 'Emma' })).toEqual([]);
  });

  it('ignores a middle name present on only one side', () => {
    expect(matchIdentity(emma, { ...emma, middleName: 'Ada' })).toEqual([]);
    expect(matchIdentity({ ...emma, middleName: 'Ada' }, emma)).toEqual([]);
  });

  it('flags a middle name that conflicts when both sides have one', () => {
    expect(matchIdentity({ ...emma, middleName: 'Ada' }, { ...emma, middleName: 'Ngozi' })).toEqual(
      ['name'],
    );
  });

  it('flags a different first or last name', () => {
    expect(matchIdentity(emma, { ...emma, firstName: 'Emeka' })).toEqual(['name']);
    expect(matchIdentity(emma, { ...emma, lastName: 'Obi' })).toEqual(['name']);
  });

  it('never matches names that normalise to nothing', () => {
    const blank = { ...emma, firstName: '--', lastName: '!!' };
    expect(matchIdentity(blank, blank)).toEqual(['name']);
  });

  it('flags a different date of birth, alone or with the name', () => {
    expect(matchIdentity(emma, { ...emma, dateOfBirth: '1995-04-13' })).toEqual(['dateOfBirth']);
    expect(matchIdentity(emma, { ...emma, lastName: 'Obi', dateOfBirth: '1990-01-01' })).toEqual([
      'name',
      'dateOfBirth',
    ]);
  });
});
