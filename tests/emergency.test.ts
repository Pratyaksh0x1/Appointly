import { describe, it, expect } from 'vitest';
import { checkEmergency, EMERGENCY_ESCALATION_HINGLISH } from '../src/safety/emergency.js';

describe('Emergency Triage Guardrail', () => {
  it('should detect chest pain in English', () => {
    const res = checkEmergency('Doctor, I am having severe chest pain right now');
    expect(res.isEmergency).toBe(true);
    expect(res.escalationMessage).toBe(EMERGENCY_ESCALATION_HINGLISH);
    expect(res.matchedKeywords.length).toBeGreaterThan(0);
  });

  it('should detect cardiac distress in Hinglish', () => {
    const res = checkEmergency('Mujhe seene me bahut tez dard ho raha hai lagta hai heart attack hai');
    expect(res.isEmergency).toBe(true);
    expect(res.matchedKeywords.some((k) => k.includes('CHEST_PAIN_CARDIAC'))).toBe(true);
  });

  it('should detect breathing difficulty in Hindi/Hinglish', () => {
    const res = checkEmergency('Mujhe saans lene me takleef ho rahi hai');
    expect(res.isEmergency).toBe(true);
    expect(res.matchedKeywords.some((k) => k.includes('BREATHING_DIFFICULTY'))).toBe(true);
  });

  it('should detect fainting and unconsciousness', () => {
    const res = checkEmergency('Patient behosh ho gaya hai');
    expect(res.isEmergency).toBe(true);
    expect(res.matchedKeywords.some((k) => k.includes('UNCONSCIOUSNESS_COLLAPSE'))).toBe(true);
  });

  it('should detect severe trauma or bleeding', () => {
    const res = checkEmergency('Bada accident ho gaya bahut khoon beh raha hai');
    expect(res.isEmergency).toBe(true);
  });

  it('should NOT trigger emergency for routine clinic queries', () => {
    const res1 = checkEmergency('Mujhe kal Dr. Sharma se appointment lena hai general checkup ke liye');
    expect(res1.isEmergency).toBe(false);

    const res2 = checkEmergency('Clinic ki timings kya hai aur consultation fee kitni hai?');
    expect(res2.isEmergency).toBe(false);

    const res3 = checkEmergency('Bachhe ko halka sa bukhar hai, pediatrician kab milenge?');
    expect(res3.isEmergency).toBe(false);
  });
});
