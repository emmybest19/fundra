// One matching rule for every adapter: compares what a person told Fundra with the record a
// provider holds for their BVN/NIN.
import type { IdentityMismatch, IdentitySubject } from './kyc-provider.ts';

/** `Chíọmá  Okafor-Eze` → `chioma okafor eze`: no accents, case or punctuation. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/**
 * First and last names match in either order (records often swap them). Middle names are
 * compared only when both sides have one, since many records and users leave it out.
 * Dates of birth must be equal.
 */
export function matchIdentity(
  subject: IdentitySubject,
  record: IdentitySubject,
): IdentityMismatch[] {
  const mismatched: IdentityMismatch[] = [];

  const core = (person: IdentitySubject) =>
    [normalizeName(person.firstName), normalizeName(person.lastName)].sort();
  const [a1, a2] = core(subject);
  const [b1, b2] = core(record);
  const subjectMiddle = normalizeName(subject.middleName ?? '');
  const recordMiddle = normalizeName(record.middleName ?? '');
  const middleConflicts =
    subjectMiddle !== '' && recordMiddle !== '' && subjectMiddle !== recordMiddle;
  if (a1 === '' || a2 === '' || a1 !== b1 || a2 !== b2 || middleConflicts) {
    mismatched.push('name');
  }

  if (subject.dateOfBirth !== record.dateOfBirth) mismatched.push('dateOfBirth');
  return mismatched;
}
