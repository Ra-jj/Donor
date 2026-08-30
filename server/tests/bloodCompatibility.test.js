const { isCompatibleDonor } = require('../utils/bloodCompatibility');

describe('Blood Compatibility Logic', () => {
  it('should return true for O- donor against every blood group (universal donor)', () => {
    const allGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
    allGroups.forEach(recipientGroup => {
      expect(isCompatibleDonor('O-', recipientGroup)).toBe(true);
    });
  });

  it('should return true for AB+ recipient accepting every donor group (universal recipient)', () => {
    const allGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
    allGroups.forEach(donorGroup => {
      expect(isCompatibleDonor(donorGroup, 'AB+')).toBe(true);
    });
  });

  it('should return false for an incompatible pair', () => {
    // A+ donor cannot give to B+ recipient
    expect(isCompatibleDonor('A+', 'B+')).toBe(false);
    
    // O+ donor cannot give to O- recipient
    expect(isCompatibleDonor('O+', 'O-')).toBe(false);
  });
});
