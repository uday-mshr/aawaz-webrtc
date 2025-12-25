/**
 * Persona enum defining available AI personas
 * Each persona has a dedicated Python worker with persona-specific prompts
 */
export enum Persona {
  RESTAURANT_RECEPTIONIST = 'restaurant_receptionist',
  UNIVERSITY_ADMISSION_COUNSELLOR = 'university_admission_counsellor',
  CLINIC_RECEPTIONIST = 'clinic_receptionist',
}

/**
 * Persona display names for UI
 */
export const PersonaDisplayNames: Record<Persona, string> = {
  [Persona.RESTAURANT_RECEPTIONIST]: 'Restaurant Receptionist',
  [Persona.UNIVERSITY_ADMISSION_COUNSELLOR]: 'University Admission Counsellor',
  [Persona.CLINIC_RECEPTIONIST]: 'Clinic Receptionist',
};

/**
 * Get all available personas
 */
export const getAvailablePersonas = (): Persona[] => {
  return Object.values(Persona);
};

