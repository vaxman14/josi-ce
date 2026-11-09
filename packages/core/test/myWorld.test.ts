import { describe, expect, it } from 'vitest';
import { describeWorldItem, refuseSecrets, WORLD_KIND_SPECS, worldKindSpec, type WorldItem } from '../src/myWorld.js';

const explorer: WorldItem = { id: 'i1', ownerUserId: 'u1', kind: 'vehicle', label: '2026 Ford Explorer', fields: { make: 'Ford', model: 'Explorer', year: '2026', color: 'blue' },
  dates: { bought: '2026-11-08' }, secretKeys: ['plate', 'vin', 'loanAccount'], secretsSet: ['plate', 'vin'], createdAt: '2026-11-08T20:00:00Z', updatedAt: '2026-11-08T20:00:00Z' };

describe('My World', () => {
  it('describes every kind with secret defaults that cover numbers, plates, VINs, PINs and codes', () => {
    for (const spec of WORLD_KIND_SPECS) expect(worldKindSpec(spec.kind)).toBe(spec);
    const secret = (kind: string) => worldKindSpec(kind)!.fields.filter((f) => f.secret).map((f) => f.key);
    expect(secret('vehicle')).toEqual(['plate', 'vin', 'loanAccount']);
    expect(secret('card')).toEqual(['number', 'cvv', 'pin']);
    expect(secret('document')).toEqual(['number']);
    expect(secret('account')).toEqual(expect.arrayContaining(['accountNumber', 'routingNumber', 'pin', 'password']));
  });
  it('refuses a secret key as a plain field, and a long number hiding in a plain field', () => {
    expect(() => refuseSecrets('vehicle', { color: 'blue' }, ['plate', 'vin'])).not.toThrow();
    expect(() => refuseSecrets('vehicle', { plate: '8ABC123' }, ['plate', 'vin'])).toThrow(/secret field/);
    expect(() => refuseSecrets('card', { notes: '4111 1111 1111 1111' }, ['number'])).toThrow(/looks like a card, account or document number/);
    expect(() => refuseSecrets('person', { phone: '951 555 0100 ext 12' }, [])).not.toThrow();
  });
  it('writes the Josi-knows line with facts and the names of the secrets, never a value', () => {
    const line = describeWorldItem(explorer);
    expect(line).toMatch(/^Vehicle: 2026 Ford Explorer \(make Ford; model Explorer; year 2026; color blue; bought 2026-11-08\)\. Added Nov 8, 2026\./);
    expect(line).toMatch(/The license plate, vin are in My World, behind the password\.$/);
    expect(line).not.toMatch(/8ABC|1FM/);
    const dana: WorldItem = { ...explorer, id: 'i2', kind: 'person', label: 'Dana', fields: { relationship: 'daughter' }, dates: { birthday: '2012-03-04' }, secretKeys: ['ssn', 'idNumber'], secretsSet: [] };
    expect(describeWorldItem(dana)).toBe('Dana is daughter (birthday 2012-03-04). Added Nov 8, 2026.');
  });
});
