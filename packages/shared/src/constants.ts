import { Doctor } from './types.js';

export const EMERGENCY_ESCALATION_HINGLISH =
  'Yeh ek medical emergency lag rahi hai! <pauses> Kripya turant nazdeeki hospital ke emergency ward jayein ' +
  'ya turant ambulance ke liye 108 dial karein. Appointly kewal routine clinic appointments book karne ke liye hai, ' +
  'emergency medical care ya diagnosis ke liye nahi. Kripya bina deri kiye emergency help lein.';

export const CLINIC_NAME = 'Arogya Care Clinic';
export const CLINIC_PHONE = '+91 98765 43210';
export const CLINIC_ADDRESS = '42, Green Glen Layout, Bellandur, Bengaluru';

export const SEEDED_DOCTORS: Doctor[] = [
  {
    id: 'dr_sharma',
    name: 'Dr. Ramesh Sharma',
    specialty: 'General Medicine & Family Physician',
    durationMinutes: 30,
    fee: 500,
    activeDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
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
    durationMinutes: 30,
    fee: 600,
    activeDays: ['Monday', 'Wednesday', 'Friday', 'Saturday'],
    availableSlots: ['10:00', '10:30', '11:00', '11:30', '12:00', '17:00', '17:30', '18:00'],
  },
  {
    id: 'dr_rajesh',
    name: 'Dr. Rajesh Kumar',
    specialty: 'Cardiologist (Heart Specialist)',
    durationMinutes: 30,
    fee: 900,
    activeDays: ['Tuesday', 'Thursday', 'Saturday'],
    availableSlots: ['17:00', '17:30', '18:00', '18:30', '19:00', '19:30'],
  },
  {
    id: 'dr_ananya',
    name: 'Dr. Ananya Iyer',
    specialty: 'Dermatologist (Skin & Hair)',
    durationMinutes: 30,
    fee: 700,
    activeDays: ['Monday', 'Tuesday', 'Thursday', 'Friday'],
    availableSlots: ['10:00', '10:30', '11:00', '11:30', '17:30', '18:00', '18:30'],
  },
];
