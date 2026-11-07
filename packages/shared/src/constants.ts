import { Doctor, AppointmentType } from './types.js';

export const EMERGENCY_ESCALATION_HINGLISH =
  'Yeh ek medical emergency lag rahi hai! <pauses> Kripya turant nazdeeki hospital ke emergency ward jayein ' +
  'ya turant ambulance ke liye 108 dial karein. Appointly kewal routine clinic appointments book karne ke liye hai, ' +
  'emergency medical care ya diagnosis ke liye nahi. Kripya bina deri kiye emergency help lein.';

export const CLINIC_NAME = 'Arogya Care Clinic';
export const CLINIC_PHONE = '+91 98765 43210';
export const CLINIC_ADDRESS = '42, Green Glen Layout, Bellandur, Bengaluru';

/**
 * Seed data: 3 dummy doctors as per Phase 2 spec
 */
export const SEEDED_DOCTORS: Doctor[] = [
  {
    id: 'dr_sharma',
    name: 'Dr. Ramesh Sharma',
    specialty: 'General Medicine & Family Physician',
    workingHoursStart: '09:00',
    workingHoursEnd: '18:00',
    activeDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    durationMinutes: 30,
    fee: 500,
    availableSlots: [
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '17:00',
      '17:30',
      '18:00',
      '18:30',
    ],
  },
  {
    id: 'dr_priya',
    name: 'Dr. Priya Patel',
    specialty: 'Pediatrician (Child Specialist)',
    workingHoursStart: '10:00',
    workingHoursEnd: '18:00',
    activeDays: ['Monday', 'Wednesday', 'Friday', 'Saturday'],
    durationMinutes: 30,
    fee: 600,
    availableSlots: ['10:00', '10:30', '11:00', '11:30', '12:00', '17:00', '17:30', '18:00'],
  },
  {
    id: 'dr_rajesh',
    name: 'Dr. Rajesh Kumar',
    specialty: 'Cardiologist (Heart Specialist)',
    workingHoursStart: '16:00',
    workingHoursEnd: '20:00',
    activeDays: ['Tuesday', 'Thursday', 'Saturday'],
    durationMinutes: 30,
    fee: 900,
    availableSlots: ['16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'],
  },
];

/**
 * Seed data: 3 visit types as per Phase 2 spec
 */
export const SEEDED_APPOINTMENT_TYPES: AppointmentType[] = [
  {
    id: 'general_consultation',
    name: 'General Consultation',
    durationMin: 30,
    fee: 500,
    description: 'Routine general physician checkup, fever, cold, vitals, initial diagnosis',
  },
  {
    id: 'follow_up',
    name: 'Follow-up Consultation',
    durationMin: 15,
    fee: 300,
    description: 'Follow-up on past test results, prescription renewal, recovery evaluation',
  },
  {
    id: 'comprehensive_checkup',
    name: 'Comprehensive Assessment',
    durationMin: 45,
    fee: 1000,
    description: 'Thorough specialized examination, cardiology/chronic health assessment',
  },
];
