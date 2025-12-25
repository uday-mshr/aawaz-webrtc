export enum Persona {
  RESTAURANT_RECEPTIONIST = 'restaurant_receptionist',
  UNIVERSITY_ADMISSION_COUNSELLOR = 'university_admission_counsellor',
  CLINIC_RECEPTIONIST = 'clinic_receptionist',
}

export const PersonaDisplayNames: Record<Persona, string> = {
  [Persona.RESTAURANT_RECEPTIONIST]: 'Restaurant Receptionist',
  [Persona.UNIVERSITY_ADMISSION_COUNSELLOR]: 'University Admission Counsellor',
  [Persona.CLINIC_RECEPTIONIST]: 'Clinic Receptionist',
};

